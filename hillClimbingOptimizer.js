'use strict'
const fetch = require('node-fetch')
const utils = require('./utils')

module.exports.handler = async () => {
  const dbClient = await utils.initMongoClient()

  const fusionConfigURL = process.env.FUSION_CONFIG
  const response = await fetch(fusionConfigURL)
  const fusionConfig = await response.json()

  const mongoData = await utils.readData(dbClient)
  console.log(mongoData)
  const oldConfig = await loadPrevConfig(dbClient)

  const averageDuration = await utils.saveCurrentConfigToDbAndReturnAverageDuration(
    mongoData,
    fusionConfig.map((deployment) => ({ lambdas: deployment.lambdas.sort() })),
    dbClient
  )

  if (
    oldConfig &&
    !oldConfig.error &&
    averageDuration < oldConfig.averageDuration
  ) {
    console.log('deploying to prod')
    await utils.sendDispatchEvent('deploy', 'prod')
  }

  console.log('old config', fusionConfig)
  let newConfig
  do {
    newConfig = utils.permutateConfigRandomly(fusionConfig)
  } while (
    await utils.configHasBeenTriedBefore(dbClient, newConfig, averageDuration)
  )

  console.log('Saving new config', newConfig)

  await utils.saveFusionConfig(newConfig)
  const data = await utils.sendDispatchEvent('deploy', 'stg')

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

const loadPrevConfig = async (dbClient) => {
  return dbClient
    .db('fusion')
    .collection('configurations')
    .findOne({}, { sort: { date: -1 } })
}
