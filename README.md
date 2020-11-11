# fusion-optimizer

Generates an optimized fusion configuration and triggers a [repository_dispatch](https://help.github.com/en/actions/reference/events-that-trigger-workflows#external-events-repository_dispatch) event on [fusion-lambdas](http://github.com/jzlai/fusion-lamnbdas).

## Prerequisites

- An application hosted on github.com
- Serverless CLI installed
- a MongoDB instance

## Installation

```
npm install
```

## Usage

```
cp .env.sample .env
```

and fill in the environment variables. By default a hill-climbing optimizer is used. You can activate the heuristics-based algorithm my editing the `serverless.yml` file.

## Deployment

```
serverless deploy
```
