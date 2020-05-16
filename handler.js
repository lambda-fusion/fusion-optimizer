"use strict";
const { Octokit } = require("@octokit/rest");

module.exports.handler = async (event) => {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  const data = await octokit.repos.createDispatchEvent({
    owner: process.env.REPO_OWNER,
    repo: process.env.REPO_NAME,
    event_type: "deploy",
  });
  console.log(data);
  return {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: "Go Serverless v1.0! Your function executed successfully!",
        input: event,
      },
      null,
      2
    ),
  };

  // Use this code if you don't use the http event with the LAMBDA-PROXY integration
  // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
