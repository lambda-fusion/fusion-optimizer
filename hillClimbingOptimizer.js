'use strict'
const fetch = require('node-fetch')
const utils = require('./utils')

module.exports.handler = async () => {
  const dbClient = await utils.initMongoClient()

  const fusionConfigURL = process.env.FUSION_CONFIG
  const response = await fetch(fusionConfigURL)
  const fusionConfig = await response.json()

  const mongoData = await utils.readData(dbClient)
  const prevConfig = (await loadPrevConfig(dbClient)) || {}

  console.log('prev config', prevConfig)

  const hasErrors = utils.configHadErrors(mongoData)

  const averageDuration = hasErrors
    ? Number.MAX_SAFE_INTEGER
    : await utils.calculateAverageDuration(mongoData)

  await utils.saveCurrentConfigToDb(
    fusionConfig.map((deployment) => ({ lambdas: deployment.lambdas.sort() })),
    dbClient,
    hasErrors,
    averageDuration,
    fusionConfig
  )

  if (
    prevConfig &&
    !prevConfig.error &&
    averageDuration < prevConfig.averageDuration
  ) {
    console.log('deploying to prod')
    await utils.sendDispatchEvent('deploy', 'prod')
  }

  let newConfig
  // this configuration is worse than the previous
  if (averageDuration > prevConfig.averageDuration) {
    // roll back to previous configuration
    console.log('Worse than prev, rolling back to', prevConfig.originalConfig)
    newConfig = prevConfig.originalConfig
  } else {
    do {
      newConfig = utils.permutateConfigRandomly(fusionConfig)
    } while (
      await utils.configHasBeenTriedBefore(dbClient, newConfig, averageDuration)
    )
  }

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
