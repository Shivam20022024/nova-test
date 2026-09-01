import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { api } from '../lib/api'
import { useToast } from './ToastContext'

type AuthContextValue = {
  currentUser: User | null
  /** True until the initial session lookup settles. Guards must wait on this. */
  authLoading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string, name: string, role: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const { triggerToast } = useToast()

  useEffect(() => {
    // The API client reads its bearer token from local storage, so every
    // session change has to be mirrored there or requests go out unauthenticated.
    const syncSession = (session: Session | null) => {
      setCurrentUser(session?.user ?? null)
      api.setToken(session?.access_token ?? null)
      setAuthLoading(false)
    }

    supabase.auth
      .getSession()
      .then(({ data }) => syncSession(data.session))
      .catch(() => setAuthLoading(false))

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => syncSession(session))

    return () => subscription.unsubscribe()
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      currentUser,
      authLoading,
      async login(email, password) {
        setAuthLoading(true)
        try {
          const { error } = await supabase.auth.signInWithPassword({ email, password })
          if (error) throw error
          triggerToast('Signed in.')
        } catch (error) {
          triggerToast((error as Error).message, true)
          throw error
        } finally {
          setAuthLoading(false)
        }
      },
      async signup(email, password, name, role) {
        setAuthLoading(true)
        try {
          // full_name and role land in user_metadata, which the app shell reads
          // for the avatar and role label.
          const { error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { full_name: name, role } },
          })
          if (error) throw error
          triggerToast('Account created. Check your email to verify it.')
        } catch (error) {
          triggerToast((error as Error).message, true)
          throw error
        } finally {
          setAuthLoading(false)
        }
      },
      async logout() {
        try {
          const { error } = await supabase.auth.signOut()
          if (error) throw error
          api.clearSession()
          triggerToast('Signed out.')
        } catch (error) {
          triggerToast((error as Error).message, true)
        }
      },
    }),
    [currentUser, authLoading, triggerToast],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
