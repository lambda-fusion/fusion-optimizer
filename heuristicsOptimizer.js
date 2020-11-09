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

  console.log('DAG loaded', dag)

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
    await utils.sendDispatchEvent('deploy')
  }
  console.log('current config', fusionConfig)

  const newConfig = await createNewConfig(
    fusionConfig,
    dag,
    dbClient,
    averageDuration
  )

  console.log('Saving new config', newConfig)

  await utils.saveFusionConfig(newConfig)
  const data = await utils.sendDispatchEvent('deploy-stg')

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

// deployment is valid if either only has 1 lambda OR
// lambdas have no connection OR
// if includes related functions, then includes all functions inbetween
const isValidConfig = (fusionConfig, dag) => {
  return fusionConfig.every((config) => {
    if (config.lambdas.length === 1) {
      return true
    }
    return config.lambdas.every((lambda1) => {
      for (const lambda2 of config.lambdas) {
        if (lambda1 === lambda2) continue
        const isDescendant = !!DFS(lambda1, lambda2, dag)
        if (isDescendant) {
          const parents = getParents(lambda2, dag)
          const hasAtLeastOneParent = parents.every((parent) =>
            config.lambdas.includes(parent)
          )

          if (!hasAtLeastOneParent) {
            return false
          }
        }
      }
      return true
    })
  })
}

const getParents = (child, dag) => {
  let parents = []
  for (const [key, value] of Object.entries(dag)) {
    if (value.includes(child)) {
      parents.push(key)
    }
  }
  return parents
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

const createNewConfig = (fusionConfig, dag, dbClient, averageDuration) => {
  const randomIndex = getRandomInt(2)
  if (randomIndex === 0) {
    return mergeLambdas(fusionConfig, dag, dbClient, averageDuration)
  } else {
    return splitLambdas(fusionConfig, dag, dbClient, averageDuration)
  }
}

const splitLambdas = async (fusionConfig, dag) => {
  console.log('SPLITTING')
  for (const config of fusionConfig) {
    if (config.lambdas.length <= 1) {
      continue
    }

    for (const i in config.lambdas) {
      for (const j in config.lambdas) {
        const fusionConfigCopy = utils.copyObject(fusionConfig)

        const lambda1 = config.lambdas[i]
        const lambda2 = config.lambdas[j]

        const isRelated =
          !!DFS(lambda1, lambda2, dag) || !!DFS(lambda2, lambda1, dag)

        if (isRelated) {
          console.log(`${lambda1} and ${lambda2} are related. Skip.`)
          continue
        }

        const indexToExtract = utils.getRandomInt(config.lambdas.length)
        const functionName = splittee.lambdas[indexToExtract]
        fusionConfigCopy.push({ lambdas: [functionName] })
        splittee.lambdas.splice(indexToExtract, 1)
        if (
          await utils.configHasBeenTriedBefore(
            dbClient,
            fusionConfigCopy,
            averageDuration
          )
        ) {
          continue
        }
        return fusionConfigCopy
      }
    }
  }
  throw new Error('No suitable config could be created')
}

//merge direct dddescendants
const mergeLambdas = async (fusionConfig, dag, dbClient, averageDuration) => {
  console.log('MERGING')
  for (const i in fusionConfig) {
    for (const j in fusionConfig) {
      if (i === j) {
        continue
      }
      const fusionConfigCopy = utils.copyObject(fusionConfig)
      const lambda1 = fusionConfig[i].lambdas[0]
      const lambda2 = fusionConfig[j].lambdas[0]

      const isRelated =
        !!DFS(lambda1, lambda2, dag) || !!DFS(lambda2, lambda1, dag)

      if (!isRelated) {
        console.log(`${lambda1} and ${lambda2} are not related. Skip.`)
        continue
      }

      fusionConfigCopy[i].lambdas = fusionConfigCopy[i].lambdas.concat(
        fusionConfigCopy[j].lambdas
      )
      fusionConfigCopy.splice(j, 1)

      const normalized = utils.normalizeEntries(fusionConfigCopy)

      if (
        await utils.configHasBeenTriedBefore(
          dbClient,
          normalized,
          averageDuration
        )
      ) {
        continue
      }
      return normalized
    }
  }
  throw new Error('No suitable config could be created')
}

const loadPrevConfig = async (dbClient) => {
  return dbClient
    .db('fusion')
    .collection('configurations')
    .findOne({}, { sort: { date: -1 } })
}
