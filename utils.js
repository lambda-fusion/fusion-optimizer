const AWS = require('aws-sdk')
const { MongoClient } = require('mongodb')
const { Octokit } = require('@octokit/rest')

const splitDeploymentsRandomly = (fusionConfig) => {
  const index = getRandomSplitIndex(fusionConfig)
  const splittee = fusionConfig[index]

  const indexToExtract = getRandomInt(splittee.lambdas.length)

  const functionName = splittee.lambdas[indexToExtract]

  fusionConfig.push({ lambdas: [functionName] })
  splittee.lambdas.splice(indexToExtract, 1)

  return fusionConfig
}

const getRandomSplitIndex = (fusionConfig) => {
  let index = getRandomInt(fusionConfig.length)
  while (fusionConfig[index].lambdas.length < 2) {
    index = getRandomInt(fusionConfig.length)
  }
  return index
}

const mergeDeploymentsRandomly = (fusionConfig) => {
  console.log('Merging')
  const deploymentCount = fusionConfig.length
  const rand1 = getRandomInt(deploymentCount)
  const rand2 = getRandomInt(deploymentCount, [rand1])
  fusionConfig[rand1].lambdas = fusionConfig[rand1].lambdas.concat(
    fusionConfig[rand2].lambdas
  )
  fusionConfig.splice(rand2, 1)
}

const normalizeEntries = (fusionConfig) => {
  for (const index in fusionConfig) {
    fusionConfig[index].entry = `handler${index}`
  }
  return fusionConfig
}

const getRandomInt = (max, duplicatesArray) => {
  if (duplicatesArray) {
    let randomNumber
    do {
      randomNumber = Math.floor(Math.random() * Math.floor(max))
    } while (duplicatesArray.includes(randomNumber))
    return randomNumber
  }
  return Math.floor(Math.random() * Math.floor(max))
}

const saveFusionConfig = async (fusionConfig) => {
  const s3 = new AWS.S3()
  const params = {
    Bucket: process.env.CONFIG_BUCKET,
    Key: 'fusionConfiguration.json',
    Body: JSON.stringify(fusionConfig),
    ContentType: `application/json`,
    ACL: 'public-read',
  }

  let location = ''
  let key = ''
  try {
    const { Location, Key } = await s3.upload(params).promise()
    location = Location
    key = Key
  } catch (error) {
    throw error
  }
  console.log(`Successfully uploaded to ${location}/${key}`)
}

const configHasBeenTriedBefore = async (
  dbClient,
  fusionConfig,
  averageDuration
) => {
  const collection = dbClient.db('fusion').collection('configurations')
  const cleanedConfig = fusionConfig
    .map((deployment) => deployment.lambdas.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]))
  console.log('cleaned config', cleanedConfig)
  const result = await collection.findOne({ fusionConfig: cleanedConfig })

  console.log('Found', result)

  if (result) {
    if (result.error) {
      console.log('This configuration had an error', result)
      return true
    }

    console.log(result.averageDuration, averageDuration)

    if (result.averageDuration > averageDuration) {
      console.log('config has been tried before', result)
      return true
    }
  }
  return false
}

const readData = async (dbClient) => {
  const collection = dbClient.db('fusion').collection('results')

  const last25Minutes = new Date(Date.now() - 1000 * 60 * 25)
  return collection.find({ starttime: { $gte: last25Minutes } }).toArray()
}

const sendDispatchEvent = async (eventType, stage) => {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })
  return octokit.repos.createDispatchEvent({
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    event_type: eventType,
    client_payload: {
      stage,
    },
  })
}

const initMongoClient = async () => {
  const dbUser = process.env.DB_USER
  const dbPassword = process.env.DB_PW
  const dbUrl = process.env.DB_URL

  const uri = `mongodb+srv://${dbUser}:${dbPassword}@${dbUrl}`
  const dbClient = new MongoClient(uri, {})
  return dbClient.connect()
}

const saveCurrentConfigToDb = async (
  inputConfig,
  dbClient,
  hasErrors,
  averageDuration,
  originalConfig
) => {
  console.log('saving current config and average time to db')

  // sort fusion config entries
  const fusionConfigCopy = JSON.parse(JSON.stringify(inputConfig))
  console.log('INPUT CONFIG', inputConfig)
  const fusionConfig = fusionConfigCopy
    .map((entry) => entry.lambdas.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]))

  const collection = dbClient.db('fusion').collection('configurations')

  if (hasErrors) {
    console.log('Execution failed at least once, discarding this configuration')
    await collection.insertOne({
      fusionConfig,
      originalConfig,
      error: true,
      date: new Date(),
    })
    return
  }

  await collection.insertOne({
    fusionConfig,
    originalConfig,
    averageDuration,
    date: new Date(),
  })
}

const configHadErrors = (mongoData) => mongoData.find((entry) => !!entry.error)

const calculateAverageDuration = (mongoData) => {
  return (
    mongoData.reduce((prev, curr) => prev + parseFloat(curr.totalDuration), 0) /
    mongoData.length
  )
}

const permutateConfigRandomly = (fusionConfig) => {
  let fusionConfigCopy = JSON.parse(JSON.stringify(fusionConfig))
  const splittingCandidates = fusionConfigCopy.filter(
    (config) => config.lambdas.length > 1
  )
  const deploymentCount = fusionConfig.length
  if (deploymentCount > 1 && splittingCandidates.length > 0) {
    const rand = getRandomInt(2)
    if (rand === 0) {
      mergeDeploymentsRandomly(fusionConfigCopy)
    } else {
      splitDeploymentsRandomly(fusionConfigCopy)
    }
  } else if (deploymentCount === 1) {
    console.log('only 1 deployment detected')
    splitDeploymentsRandomly(fusionConfigCopy)
  } else {
    console.log('no splittable deployments found')
    mergeDeploymentsRandomly(fusionConfigCopy)
  }
  normalizeEntries(fusionConfigCopy)

  return fusionConfigCopy
}

const copyObject = (o) => JSON.parse(JSON.stringify(o))

module.exports = {
  splitDeploymentsRandomly,
  normalizeEntries,
  saveFusionConfig,
  mergeDeploymentsRandomly,
  getRandomInt,
  configHasBeenTriedBefore,
  readData,
  sendDispatchEvent,
  initMongoClient,
  saveCurrentConfigToDb,
  permutateConfigRandomly,
  copyObject,
  calculateAverageDuration,
  configHadErrors,
}
