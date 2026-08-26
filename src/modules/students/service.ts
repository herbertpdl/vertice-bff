import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
import { ForbiddenError } from '../../lib/errors.js'

export interface StudentSummary extends userService.User {
  activePlanCount: number
}

/** A trainer's roster is derived from the distinct clients across their training plans — User has no direct trainer/client link. */
export async function listStudentsForTrainer(trainerId: number): Promise<StudentSummary[]> {
  const plans = await planService.listTrainingPlans({ trainerId })
  const countByClient = new Map<number, number>()
  for (const plan of plans) {
    countByClient.set(plan.clientId, (countByClient.get(plan.clientId) ?? 0) + 1)
  }

  const clients = await Promise.all([...countByClient.keys()].map((id) => userService.getUser(id)))
  return clients.map((client) => ({ ...client, activePlanCount: countByClient.get(client.id) ?? 0 }))
}

export async function assertIsTrainersClient(trainerId: number, clientId: number): Promise<void> {
  const plans = await planService.listTrainingPlans({ trainerId, clientId })
  if (plans.length === 0) {
    throw new ForbiddenError('This client is not one of your students')
  }
}
