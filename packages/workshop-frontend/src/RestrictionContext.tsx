// LOCAL PATCH: restricted-view — remove when fixed upstream
//
// Carries the signed-in user's pinned-workspace restriction (or null) to the few components that
// need to trim chrome for it. This is ERGONOMICS ONLY: the real gate is RestrictedAuthenticatedApi
// in the backend, which denies every method regardless of what the client renders. Nothing here
// may ever be the reason a restricted user cannot reach something.

import { createContext, useContext } from 'react'
import type { RestrictionInfo } from '@gadgets/workshop-shared/api'

const RestrictionContext = createContext<RestrictionInfo | null>(null)

export const RestrictionProvider = RestrictionContext.Provider

/** The caller's restriction, or null when they are unrestricted (the normal case). */
export function useRestriction(): RestrictionInfo | null {
  return useContext(RestrictionContext)
}
