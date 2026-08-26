import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  VERTICE_API_GRPC_HOST: z.string().default('localhost'),
  VERTICE_API_GRPC_PORT: z.coerce.number().default(9090),
  JWT_SECRET: z.string().min(1).default('dev-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('8h'),
})

export const env = envSchema.parse(process.env)

export const grpcTarget = `${env.VERTICE_API_GRPC_HOST}:${env.VERTICE_API_GRPC_PORT}`
