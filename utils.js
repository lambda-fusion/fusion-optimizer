const AWS = require('aws-sdk')

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

module.exports = {
  splitDeployments,
  normalizeEntries,
  saveFusionConfig,
  mergeDeployments,
  getRandomInt,
}
