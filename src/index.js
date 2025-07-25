/* eslint-disable import/no-import-module-exports */
/* eslint-disable max-classes-per-file */
import { EventEmitter } from 'events'
import { parseURL } from 'ioredis/built/utils/index'

import { list as redisCommands } from '../data/command-list.json'
import createCommand, { Command } from './command'
import * as commands from './commands'
import * as commandsStream from './commands-stream'
import emitConnectEvent from './commands-utils/emitConnectEvent'
import emitDisconnectEvent from './commands-utils/emitDisconnectEvent'
import contextMap, { createContext } from './context'
import { createData } from './data'
import { createExpires } from './expires'
import parseKeyspaceEvents from './keyspace-notifications'
import Pipeline from './pipeline'

const defaultOptions = {
  data: {},
  keyPrefix: '',
  lazyConnect: false,
  notifyKeyspaceEvents: '', // string pattern as specified in https://redis.io/topics/notifications#configuration e.g. 'gxK'
  host: 'localhost',
  port: 6379,
}

const pathToHostPort = path => {
  const { host, port } = parseURL(path)
  return { host, port }
}

const routeOptionsArgs = (...args) => {
  switch (args.length) {
    case 3:
      // port: number, host: string, options: IRedisOptions
      return { ...args[2], port: args[0], host: args[1] }

    case 2:
      // if args[0] is a string, then it's:
      // path: string, options: IRedisOptions
      // if args[0] is a number and args[1] is a string, then it's:
      // port: number, host: string
      // if neither we can assume it's:
      // port: number, options: IRedisOptions
      // eslint-disable-next-line no-nested-ternary
      return typeof args[0] === 'string'
        ? { ...args[1], ...pathToHostPort(args[0]) }
        : Number.isInteger(args[0]) && typeof args[1] === 'string'
        ? { port: args[0], host: args[1] }
        : { ...args[1], port: args[0] }
    case 1:
      // if args[0] is a string, then it's:
      // path: string
      // if args[0] is a number then it's:
      // port: number
      // if neither we can assume it's:
      //  options: IRedisOptions
      // eslint-disable-next-line no-nested-ternary
      return typeof args[0] === 'string'
        ? { ...pathToHostPort(args[0]) }
        : Number.isInteger(args[0])
        ? { port: args[0] }
        : { ...args[0] }
    default:
      return {}
  }
}

const getOptions = (...args) => {
  const parsed = routeOptionsArgs(...args)
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultOptions.port
  const { host = defaultOptions.host } = parsed

  return { ...parsed, port, host }
}

class RedisMock extends EventEmitter {
  constructor(...args) {
    super()

    this.batch = undefined
    this.connected = false
    this.subscriberMode = false
    this.customCommands = {}
    // a mapping of sha1<string>:script<string>, used by evalsha command
    this.shaScripts = {}

    const optionsWithDefault = { ...defaultOptions, ...getOptions(...args) }

    this.keyData = `${optionsWithDefault.host}:${optionsWithDefault.port}`

    if (!contextMap.get(this.keyData)) {
      const context = createContext(optionsWithDefault.keyPrefix)

      contextMap.set(this.keyData, context)
    }

    const context = contextMap.get(this.keyData)

    this.expires = createExpires(context.expires, optionsWithDefault.keyPrefix)
    this.data = createData(
      context.data,
      this.expires,
      optionsWithDefault.data,
      optionsWithDefault.keyPrefix
    )

    this._initCommands()

    this.keyspaceEvents = parseKeyspaceEvents(
      optionsWithDefault.notifyKeyspaceEvents
    )

    if (optionsWithDefault.lazyConnect === false) {
      this.connected = true
      emitConnectEvent(this)
    }
    this.options = optionsWithDefault
  }

  get channels() {
    return contextMap.get(this.keyData).channels
  }

  set channels(channels) {
    const oldContext = contextMap.get(this.keyData)

    const newContext = {
      ...oldContext,
      channels,
    }

    contextMap.set(this.keyData, newContext)
  }

  get patternChannels() {
    return contextMap.get(this.keyData).patternChannels
  }

  set patternChannels(patternChannels) {
    const oldContext = contextMap.get(this.keyData)

    const newContext = {
      ...oldContext,
      patternChannels,
    }

    contextMap.set(this.keyData, newContext)
  }

  multi(batch = []) {
    this.batch = new Pipeline(this)
    // eslint-disable-next-line no-underscore-dangle
    this.batch._transactions += 1

    batch.forEach?.(([command, ...options]) => this.batch[command](...options))

    return this.batch
  }

  pipeline(batch = []) {
    this.batch = new Pipeline(this)

    batch.forEach(([command, ...options]) => this.batch[command](...options))

    return this.batch
  }

  exec(callback) {
    if (!this.batch) {
      return Promise.reject(new Error('ERR EXEC without MULTI'))
    }
    const pipeline = this.batch
    this.batch = undefined
    return pipeline.exec(callback)
  }

  duplicate(override) {
    const mock = new RedisMock({ ...this.options, ...override })
    mock.expires = this.expires
    mock.data = this.data
    mock.channels = this.channels
    mock.patternChannels = this.patternChannels
    return mock
  }

  // eslint-disable-next-line class-methods-use-this
  disconnect() {
    const removeFrom = ({ instanceListeners }) => {
      if (!instanceListeners) {
        return
      }

      instanceListeners.forEach(mapOfInstanceToListener => {
        mapOfInstanceToListener.forEach((listener, instance) => {
          if (instance === this) {
            mapOfInstanceToListener.delete(instance)
          }
        })
      })
    }

    removeFrom(this.channels)
    removeFrom(this.patternChannels)

    emitDisconnectEvent(this)
    // no-op
  }

  _initCommands() {
    Object.keys(commands).forEach(command => {
      const commandName = command === 'evaluate' ? 'eval' : command
      this[commandName] = createCommand(
        commands[command].bind(this),
        commandName,
        this
      )
    })

    Object.keys(commandsStream).forEach(command => {
      this[command] = commandsStream[command].bind(this)
    })

    const list = redisCommands.filter(cmd => !cmd.includes('|'))
    const supportedCommands = [
      ...list,
      ...list.map(command => `${command}Buffer`),
    ]
    const docsLink =
      'https://github.com/stipsan/ioredis-mock/blob/main/compat.md#supported-commands-'
    supportedCommands.forEach(command => {
      if (!(command in this)) {
        Object.defineProperty(this, command, {
          value: () => {
            throw new TypeError(
              `Unsupported command: ${JSON.stringify(
                command
              )}, please check the full list over mocked commands: ${docsLink}`
            )
          },
          writable: true,
        })
      }
    })
  }
}

RedisMock.Command = Command

RedisMock.Cluster = class RedisClusterMock extends RedisMock {
  constructor(nodesOptions, clusterOptions) {
    if (clusterOptions && clusterOptions.redisOptions) {
      super(clusterOptions.redisOptions)
    } else {
      super()
    }
    nodesOptions.forEach(options =>
      this.clusterNodes.all.push(new RedisMock(options))
    )
  }

  clusterNodes = {
    all: [],
    master: [],
    slave: [],
  }

  nodes(role = 'all') {
    if (role !== 'all' && role !== 'master' && role !== 'slave') {
      throw new Error(
        `Invalid role "${role}". Expected "all", "master" or "slave"`
      )
    }
    return this.clusterNodes.all // temporary return all until implemented slave and master logic
  }
}

RedisMock.default = RedisMock

module.exports = RedisMock
