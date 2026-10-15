import { z } from 'zod'
import { requiredText } from '../../lib/validation.js'

export const submitFeedbackSchema = z.object({
  // vertice-api: not blank, at most 2000 (`VARCHAR(2000)`).
  text: requiredText(2000),
}).meta({ id: 'SubmitFeedbackRequest' })
