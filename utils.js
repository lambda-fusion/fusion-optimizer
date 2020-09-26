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
    fusionConfig[index].entry = `handler${index}-stg`
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
  if (result && result.averageDuration > averageDuration) {
    console.log('config has been tried before', result)
    return true
  }
  return false
}

const readData = async (dbClient) => {
  const collection = dbClient.db('fusion').collection('results')
  return collection.find().limit(5).sort({ starttime: -1 }).toArray()
}

const sendDispatchEvent = async (eventType) => {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })
  return octokit.repos.createDispatchEvent({
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    event_type: eventType,
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

const saveCurrentConfigToDb = async (mongoData, inputConfig, dbClient) => {
  const averageDuration =
    mongoData.reduce((prev, curr) => prev + parseFloat(curr.totalDuration), 0) /
    mongoData.length

  const fusionConfigCopy = JSON.parse(JSON.stringify(inputConfig))
  const fusionConfig = fusionConfigCopy
    .map((entry) => entry.lambdas.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]))

  const collection = dbClient.db('fusion').collection('configurations')
  await collection.insertOne({
    fusionConfig,
    averageDuration,
    date: new Date(),
  })
  return averageDuration
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
}
