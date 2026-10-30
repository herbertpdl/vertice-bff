# Spec: Lazy exercise search (BFF)

Status: Draft
Owner: hebertpdl@gmail.com
Related: vertice-api [`docs/specs/lazy-exercise-search/spec.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/lazy-exercise-search/spec.md)
(the paged `ListExercises` this exposes; its §0 decisions apply here)

## 1. Route

`GET /exercises?muscleGroupId&q&limit&cursor` → `200 { exercises: Exercise[], nextCursor: string | null }`.

| Query | Rule (BFF, fail fast) | Upstream field |
|---|---|---|
| `muscleGroupId` | unchanged | `muscle_group_id` |
| `q` | unchanged (trimmed, ≤ 100 UTF-16 units) | `search` |
| `limit` | integer 1–50; absent → upstream default 30. Above 50 is a 400, not lowered, so a client never thinks it got everything | `page_size` |
| `cursor` | string ≤ 64; content checked upstream (`INVALID_ARGUMENT` → 400) | `page_token` |

`nextCursor` is upstream's `next_page_token`, with `''` mapped to `null`. Order and contents are
upstream's, never re-sorted.

**Breaking:** the body was a bare `Exercise[]`. Every consumer (vertice-web-react, vertice-mobile)
moves in its own PR, pinned to this one; nothing is deployed yet.

## 2. Merge and deploy order

vertice-api #78 → this PR (re-pin `protos/.api-ref` to the API merge SHA) → vertice-web-react and
vertice-mobile (re-pin `.bff-ref`). Deploy the BFF together with, or after, the web build.
