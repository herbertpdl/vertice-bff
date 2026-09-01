import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as protoLoader from '@grpc/proto-loader'
import * as grpc from '@grpc/grpc-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROTOS_ROOT = path.resolve(__dirname, '../../protos')

const PROTO_FILES = [
  'vertice/user/v1/user.proto',
  'vertice/exercise/v1/exercise.proto',
  'vertice/plan/v1/training_plan.proto',
  'vertice/plan/v1/workout.proto',
  'vertice/plan/v1/workout_exercise.proto',
  'vertice/plan/v1/exercise_set.proto',
  'vertice/session/v1/workout_session.proto',
  'vertice/session/v1/workout_feedback.proto',
  'vertice/trainerclient/v1/trainer_client.proto',
].map((file) => path.join(PROTOS_ROOT, file))

const packageDefinition = protoLoader.loadSync(PROTO_FILES, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTOS_ROOT],
})

// `grpc.loadPackageDefinition` returns a deeply nested, dynamically-shaped
// object (one property per proto package segment) — there's no static type
// for it, so callers work with the concrete `vertice.*.v1.*` services below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const grpcProto = grpc.loadPackageDefinition(packageDefinition) as any
