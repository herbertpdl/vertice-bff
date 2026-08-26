import { userClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

export interface User {
  id: number
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
}

interface UserResponse {
  id: string
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
}

function toUser(r: UserResponse): User {
  return { id: Number(r.id), name: r.name, email: r.email, cpf: r.cpf, cref: r.cref, role: r.role }
}

export async function listUsers(role?: Role): Promise<User[]> {
  const res = await grpcCall<{ role: string }, { users: UserResponse[] }>(userClient, 'ListUsers', {
    role: role ?? 'ROLE_UNSPECIFIED',
  })
  return res.users.map(toUser)
}

export async function getUser(id: number): Promise<User> {
  const res = await grpcCall<{ id: number }, UserResponse>(userClient, 'GetUser', { id })
  return toUser(res)
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const users = await listUsers()
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase())
}

export interface UserCreateInput {
  name: string
  email: string
  password: string
  cpf?: string
  cref?: string
  role: Role
}

export async function createUser(input: UserCreateInput): Promise<User> {
  const res = await grpcCall<UserCreateInput, UserResponse>(userClient, 'CreateUser', {
    ...input,
    cpf: input.cpf ?? '',
    cref: input.cref ?? '',
  })
  return toUser(res)
}

export interface UserUpdateInput {
  name: string
  email: string
  cpf?: string
  cref?: string
  role: Role
}

export async function updateUser(id: number, input: UserUpdateInput): Promise<User> {
  const res = await grpcCall<{ id: number; user: UserUpdateInput }, UserResponse>(userClient, 'UpdateUser', {
    id,
    user: { ...input, cpf: input.cpf ?? '', cref: input.cref ?? '' },
  })
  return toUser(res)
}

export async function deleteUser(id: number): Promise<void> {
  await grpcCall(userClient, 'DeleteUser', { id })
}

export async function setUserPassword(id: number, password: string): Promise<void> {
  await grpcCall(userClient, 'SetUserPassword', { id, password })
}
