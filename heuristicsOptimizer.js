'use strict'
const { Octokit } = require('@octokit/rest')
const fetch = require('node-fetch')
const { getRandomInt } = require('./utils')
const utils = require('./utils')

module.exports.handler = async (event) => {
  const dbClient = await utils.initMongoClient()

  const fusionConfigURL = process.env.FUSION_CONFIG
  const response = await fetch(fusionConfigURL)
  const fusionConfig = await response.json()

  const mongoData = await utils.readData(dbClient)

  const dag = await loadDAG()

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
  if (hasErrors && prevConfig.originalConfig) {
    // roll back to previous configuration
    console.log(
      'Deployment had errors. Rolling back.',
      prevConfig.originalConfig
    )
    newConfig = prevConfig.originalConfig
  } else {
    newConfig = await createNewDeploymentConfig(
      fusionConfig,
      dag,
      dbClient,
      averageDuration
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

const DFS = (source, target, dag, stack) => {
  if (!stack) {
    stack = []
  }
  if (source === target) {
    return source
  } else {
    if (!dag[source]) {
      return undefined
    }
    stack = stack.concat(dag[source])
    while (stack.length > 0) {
      const newNode = stack.pop()
      return DFS(newNode, target, dag, stack)
    }
  }
}

const loadDAG = async () => {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })
  const content = (
    await octokit.repos.getContents({
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
      path: 'dag.json',
    })
  ).data.content

  if (!content) {
    console.log('dag.json not found')
    return
  }

  const dag = JSON.parse(Buffer.from(content, 'base64').toString())
  return dag
}

const createNewDeploymentConfig = async (
  fusionConfig,
  dag,
  dbClient,
  averageDuration
) => {
  console.log('create new config')
  for (let i = 0; i < fusionConfig.length; i++) {
    for (const lambda of fusionConfig[i].lambdas) {
      const fusionConfigCopy = utils.copyObject(fusionConfig)
      const children = getChildIndexes(fusionConfig, dag[lambda], i)
      console.log('current lambda', lambda, dag[lambda])
      console.log('child indexes', children)

      // skip if lambda has no fusable children
      if (children.length === 0) {
        continue
      }

      // add all children to current deployment unit
      children.forEach((j) => {
        fusionConfigCopy[i].lambdas = fusionConfigCopy[i].lambdas.concat(
          fusionConfig[j].lambdas
        )
      })

      // remove all fused entries
      const result = fusionConfigCopy.filter(
        (_, index) => !children.includes(index)
      )
      console.log('merged config:', result)
      if (
        await utils.configHasBeenTriedBefore(dbClient, result, averageDuration)
      ) {
        continue
      }
      return utils.normalizeEntries(result)
    }
  }
  throw new Error('No suitable config could be created')
}

const getChildIndexes = (fusionConfig, children = [], currentIndex) => {
  const indexes = []
  for (const child of children) {
    fusionConfig.forEach((_, index) => {
      if (index === currentIndex) {
        return
      }
      if (
        fusionConfig[index].lambdas.includes(child) &&
        !indexes.includes(index)
      ) {
        indexes.push(index)
      }
    })
  }
  return indexes
}

const loadPrevConfig = async (dbClient) => {
  return dbClient
    .db('fusion')
    .collection('configurations')
    .findOne({}, { sort: { date: -1 } })
}
