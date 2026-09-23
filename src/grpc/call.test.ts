import { describe, expect, it } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import { mapGrpcError } from './call.js'
import { PreconditionFailedError, ValidationError } from '../lib/errors.js'

describe('mapGrpcError', () => {
  it('maps FAILED_PRECONDITION to 409 PRECONDITION_FAILED with the upstream message verbatim', () => {
    const details = "Cannot replace exercises: exercise 'Supino reto' (id 12) set 2 has recorded workout data"
    const err = mapGrpcError({ code: grpc.status.FAILED_PRECONDITION, details })
    expect(err).toBeInstanceOf(PreconditionFailedError)
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PRECONDITION_FAILED')
    expect(err.message).toBe(details)
  })

  it('still maps INVALID_ARGUMENT to 400 VALIDATION_ERROR', () => {
    const err = mapGrpcError({
      code: grpc.status.INVALID_ARGUMENT,
      details: 'exercise_id: one or more referenced exercises do not exist',
    })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('exercise_id: one or more referenced exercises do not exist')
  })

  it('maps NOT_FOUND to 404 with the upstream message verbatim', () => {
    const err = mapGrpcError({ code: grpc.status.NOT_FOUND, details: 'Workout with id 7 not found' })
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('Workout with id 7 not found')
  })

  it('falls back to a generic NOT_FOUND message when upstream sends none', () => {
    const err = mapGrpcError({ code: grpc.status.NOT_FOUND, details: '' })
    expect(err.message).toBe('Resource not found')
  })
})
