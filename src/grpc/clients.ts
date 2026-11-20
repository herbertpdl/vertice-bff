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
/** `service:bff` only, from `modules/admin-auth/service.ts` (admin sign-in's second factor). */
export const adminAuthClient = new grpcProto.vertice.admin.v1.AdminAuthService(grpcTarget, credentials)
/**
 * `service:ops` only: imported by the ops scripts (`src/ops/`), never by the server (admin-panel
 * spec B6; pinned by a source scan in `route-authorization.test.ts`).
 */
export const adminOpsClient = new grpcProto.vertice.admin.v1.AdminOpsService(grpcTarget, credentials)
/** The admin panel (`modules/admin/service.ts`), always with the caller's admin token. */
export const adminClient = new grpcProto.vertice.admin.v1.AdminService(grpcTarget, credentials)
/** Starter-catalog curation and the most-used list (`modules/admin/service.ts`), with the caller's admin token. */
export const adminCatalogClient = new grpcProto.vertice.admin.v1.AdminCatalogService(grpcTarget, credentials)
/**
 * Feature-flag evaluation (`modules/feature-flags/service.ts` only), always with the caller's own
 * token: never `asService`, never in `SERVICE_TOKEN_RPCS` (feature-flags spec FF1, FF4).
 */
export const featureFlagClient = new grpcProto.vertice.featureflag.v1.FeatureFlagService(grpcTarget, credentials)
/** The admin panel's Feature flags page (`modules/admin/service.ts`), with the caller's admin token. */
export const adminFeatureFlagClient = new grpcProto.vertice.admin.v1.AdminFeatureFlagService(
  grpcTarget,
  credentials,
)
