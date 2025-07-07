import Redis from 'ioredis'

describe('disconnect', () => {
  it('should be available and emit "end" event', done => {
    const redis = new Redis({})
    let eventEmitted = false

    expect(redis.disconnect()).toBe(undefined)

    redis.on('end', () => {
      eventEmitted = true

      expect(eventEmitted).toEqual(true)
      done()
    })
  })
})
