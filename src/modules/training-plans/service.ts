import { trainingPlanClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export type PlanLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED'

export interface TrainingPlan {
  id: number
  name: string
  description: string
  trainerId: number
  clientId: number
  startDate: string
  endDate: string
  level: PlanLevel
}

interface TrainingPlanResponse {
  id: string
  name: string
  description: string
  trainerId: string
  clientId: string
  startDate: string
  endDate: string
  level: PlanLevel
}

function toPlan(r: TrainingPlanResponse): TrainingPlan {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    trainerId: Number(r.trainerId),
    clientId: Number(r.clientId),
    startDate: r.startDate,
    endDate: r.endDate,
    level: r.level,
  }
}

export async function listTrainingPlans(filter: {
  trainerId?: number
  clientId?: number
}): Promise<TrainingPlan[]> {
  const res = await grpcCall<
    { trainerId: number; clientId: number },
    { trainingPlans: TrainingPlanResponse[] }
  >(trainingPlanClient, 'ListTrainingPlans', {
    trainerId: filter.trainerId ?? 0,
    clientId: filter.clientId ?? 0,
  })
  return res.trainingPlans.map(toPlan)
}

export async function getTrainingPlan(id: number): Promise<TrainingPlan> {
  const res = await grpcCall<{ id: number }, TrainingPlanResponse>(
    trainingPlanClient,
    'GetTrainingPlan',
    { id },
  )
  return toPlan(res)
}

export interface TrainingPlanCreateInput {
  name: string
  description: string
  clientId: number
  startDate: string
  endDate: string
  level: PlanLevel
}

export async function createTrainingPlan(
  trainerId: number,
  input: TrainingPlanCreateInput,
): Promise<TrainingPlan> {
  const res = await grpcCall<TrainingPlanCreateInput & { trainerId: number }, TrainingPlanResponse>(
    trainingPlanClient,
    'CreateTrainingPlan',
    { ...input, trainerId },
  )
  return toPlan(res)
}

export async function updateTrainingPlan(
  id: number,
  input: TrainingPlanCreateInput,
): Promise<TrainingPlan> {
  const res = await grpcCall<{ id: number; trainingPlan: TrainingPlanCreateInput }, TrainingPlanResponse>(
    trainingPlanClient,
    'UpdateTrainingPlan',
    { id, trainingPlan: input },
  )
  return toPlan(res)
}

export async function deleteTrainingPlan(id: number): Promise<void> {
  await grpcCall(trainingPlanClient, 'DeleteTrainingPlan', { id })
}
