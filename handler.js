'use strict'
const { Octokit } = require('@octokit/rest')
const { MongoClient } = require('mongodb')
const AWS = require('aws-sdk')

module.exports.handler = async (event) => {
  const dbClient = await initMongoClient()

  const fusionConfigURL = process.env.FUSION_CONFIG
  const response = await fetch(fusionConfigURL)
  const fusionConfig = await response.json()

  const mongoData = await readData(dbClient)

  console.log('saving current config and average time to db')

  const averageDuration = await saveCurrentConfigToDb(
    mongoData,
    fusionConfig.map((deployment) => ({ lambdas: deployment.lambdas })),
    dbClient
  )

  console.log('old config', fusionConfig)

  let newConfig

  do {
    newConfig = permutateConfig(fusionConfig)
  } while (await configHasBeenTriedBefore(dbClient, newConfig, averageDuration))

  console.log('Saving new config', newConfig)

  await saveFusionConfig(newConfig)
  const data = await sendDispatchEvent()

  console.log(data)

  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: 'Sent dipatch event!',
      },
      null,
      2
    ),
  }
}

const configHasBeenTriedBefore = async (
  dbClient,
  fusionConfig,
  averageDuration
) => {
  const collection = dbClient.db('fusion').collection('configurations')
  const cleanedConfig = fusionConfig.map((deployment) => ({
    lambdas: deployment.lambdas,
  }))
  const result = await collection.findOne({ fusionConfig: cleanedConfig })
  console.log(result)
  if (result && result.averageDuration > averageDuration) {
    console.log('config has been tried before')
    return true
  }
  return false
}

const readData = async (dbClient) => {
  const collection = dbClient.db('fusion').collection('results')
  return collection.find().limit(5).sort({ starttime: -1 }).toArray()
}

const sendDispatchEvent = async () => {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })
  return octokit.repos.createDispatchEvent({
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    event_type: 'deploy',
  })
}

const saveCurrentConfigToDb = async (mongoData, fusionConfig, dbClient) => {
  const averageDuration =
    mongoData.reduce((prev, curr) => prev + parseFloat(curr.totalDuration), 0) /
    mongoData.length

  const collection = dbClient.db('fusion').collection('configurations')
  await collection.insertOne({
    fusionConfig,
    averageDuration,
    date: new Date(),
  })
  return averageDuration
}

const loadPrevConfig = async (dbClient) => {
  return dbClient
    .db('fusion')
    .collection('configurations')
    .findOne({}, { sort: { date: -1 } })
}

const initMongoClient = async () => {
  const dbUser = process.env.DB_USER
  const dbPassword = process.env.DB_PW

  const uri = `mongodb+srv://${dbUser}:${dbPassword}@fusion-db-ul7hq.mongodb.net/test?retryWrites=true&w=majority`
  const dbClient = new MongoClient(uri, {})
  return dbClient.connect()
}

const permutateConfig = (fusionConfig) => {
  let fusionConfigCopy = JSON.parse(JSON.stringify(fusionConfig))
  const splittingCandidates = fusionConfigCopy.filter(
    (config) => config.lambdas.length > 1
  )
  const deploymentCount = fusionConfig.length
  const functionCount = fusionConfig.reduce(
    (prev, curr) => prev + curr.lambdas.length,
    0
  )
  if (deploymentCount > 1 && splittingCandidates.length > 0) {
    const rand = getRandomInt(2)
    if (rand === 0) {
      mergeDeployments(fusionConfigCopy)
    } else {
      splitDeployments(fusionConfigCopy)
    }
  } else if (deploymentCount === 1) {
    console.log('only 1 deployment detected')
    splitDeployments(fusionConfigCopy)
  } else {
    console.log('no splittable deployments found')
    mergeDeployments(fusionConfigCopy)
  }
  normalizeEntries(fusionConfigCopy)

  return fusionConfigCopy
}

const splitDeployments = (fusionConfig) => {
  const index = getSplitIndex(fusionConfig)
  const splittee = fusionConfig[index]

  const indexToExtract = getRandomInt(splittee.lambdas.length)

  const functionName = splittee.lambdas[indexToExtract]

  fusionConfig.push({ lambdas: [functionName] })
  splittee.lambdas.splice(indexToExtract, 1)

  return fusionConfig
}

const getSplitIndex = (fusionConfig) => {
  let index = getRandomInt(fusionConfig.length)
  while (fusionConfig[index].lambdas.length < 2) {
    index = getRandomInt(fusionConfig.length)
  }
  return index
}

const mergeDeployments = (fusionConfig) => {
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
