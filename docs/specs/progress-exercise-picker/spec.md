# Spec: Progress exercise picker (BFF)

Status: Draft
Owner: hebertpdl@gmail.com
Related: vertice-api [`docs/specs/progress-exercise-picker/spec.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/progress-exercise-picker/spec.md)
(the analysis and decisions; `ListProgressExercises`)

## 1. Route

`GET /exercises/with-progress?clientId=` → `200 ProgressExercise[]` (`{ id, name }`), upstream
`ListProgressExercises` as is (order and visibility are vertice-api's).

- Roles TRAINER, CLIENT: the same as `GET /exercises/:id/progress`, whose options this lists. A
  CLIENT's `clientId` is ignored (their own is sent); a TRAINER must pass it (400 when missing) and
  it must be one of their clients (`assertIsTrainersClient`, 403). ADMIN: 403 by role, like the
  progress route.
- Not paged: bounded by the client's training history, not by the catalog.
- Static segment next to `/:id`: find-my-way matches `with-progress` before the param route.

Additive: no existing route or shape changes.

## 2. Merge and deploy order

vertice-api → this (re-pin `protos/.api-ref` to the API merge) → vertice-web-react and
vertice-mobile (re-pin `.bff-ref`), merged one after the other once all four are approved and
green. Additive, so any deploy order works.
