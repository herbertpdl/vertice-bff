import * as grpc from '@grpc/grpc-js'
import { grpcTarget } from '../config/env.js'
import { grpcProto } from './loadProto.js'

// vertice-api's grpc server currently runs without TLS locally (spring.grpc.server.port=9090).
const credentials = grpc.credentials.createInsecure()

export const userClient = new grpcProto.vertice.user.v1.UserService(grpcTarget, credentials)
export const exerciseClient = new grpcProto.vertice.exercise.v1.ExerciseService(grpcTarget, credentials)
export const trainingPlanClient = new grpcProto.vertice.plan.v1.TrainingPlanService(grpcTarget, credentials)
export const workoutClient = new grpcProto.vertice.plan.v1.WorkoutService(grpcTarget, credentials)
export const workoutExerciseClient = new grpcProto.vertice.plan.v1.WorkoutExerciseService(
  grpcTarget,
  credentials,
)
export const exerciseSetClient = new grpcProto.vertice.plan.v1.ExerciseSetService(grpcTarget, credentials)
export const workoutSessionClient = new grpcProto.vertice.session.v1.WorkoutSessionService(
  grpcTarget,
  credentials,
)
export const workoutFeedbackClient = new grpcProto.vertice.session.v1.WorkoutFeedbackService(
  grpcTarget,
  credentials,
)
export const trainerClientClient = new grpcProto.vertice.trainerclient.v1.TrainerClientService(
  grpcTarget,
  credentials,
)
