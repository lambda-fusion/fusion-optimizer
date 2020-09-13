'use strict'
const { Octokit } = require('@octokit/rest')
const fetch = require('node-fetch')
const utils = require('./utils')

module.exports.handler = async (event) => {
  const dbClient = await utils.initMongoClient()

  const fusionConfigURL = process.env.FUSION_CONFIG
  const response = await fetch(fusionConfigURL)
  const fusionConfig = await response.json()

  const mongoData = await utils.readData(dbClient)

  const dag = await loadDAG()

  console.log('DAG loaded', dag)

  console.log('saving current config and average time to db')

  const averageDuration = await utils.saveCurrentConfigToDb(
    mongoData,
    fusionConfig.map((deployment) => ({ lambdas: deployment.lambdas.sort() })),
    dbClient
  )
  console.log('old config', fusionConfig)

  // let newConfig
  // do {
  //   newConfig = createNewConfig(fusionConfig, dag)
  // } while (
  //   (await utils.configHasBeenTriedBefore(
  //     dbClient,
  //     newConfig,
  //     averageDuration
  //   )) ||
  //   !isValidConfig(fusionConfig, dag)
  // )
  const newConfig = createNewConfig(fusionConfig, dag)
  console.log(newConfig)

  console.log('Saving new config', newConfig)

  await utils.saveFusionConfig(newConfig)
  const data = await utils.sendDispatchEvent()

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
// if includes descendant, then also includes at least 1 parent
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

//merge direct descendants
const createNewConfig = (fusionConfig, dag) => {
  for (const i in fusionConfig) {
    for (const j in fusionConfig) {
      if (i === j) {
        continue
      }
      const lambda1 = fusionConfig[i].lambdas[0]
      const lambda2 = fusionConfig[j].lambdas[0]

      const isRelated =
        !!DFS(lambda1, lambda2, dag) || !!DFS(lambda2, lambda1, dag)

      if (!isRelated) {
        continue
      }

      fusionConfig[i].lambdas = fusionConfig[i].lambdas.concat(
        fusionConfig[j].lambdas
      )
      fusionConfig.splice(j, 1)
    }
    return utils.normalizeEntries(fusionConfig)
  }

  throw new Error('No suitable config could be created')
}

const loadPrevConfig = async (dbClient) => {
  return dbClient
    .db('fusion')
    .collection('configurations')
    .findOne({}, { sort: { date: -1 } })
}
