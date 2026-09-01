import { lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import AppLayout from '../layouts/AppLayout'
import MarketingLayout from '../layouts/MarketingLayout'
import LandingPage from '../pages/marketing/LandingPage'
import LoginPage from '../pages/auth/LoginPage'
import CreateAccountPage from '../pages/auth/CreateAccountPage'
import NotFoundPage from '../pages/NotFoundPage'
import { RedirectIfAuthenticated, RequireAuth } from './guards'

const CommandCenterPage = lazy(() => import('../pages/app/command-center/CommandCenterPage'))
const OneClickTestPage = lazy(() => import('../pages/app/one-click-test/OneClickTestPage'))
const CodeGeneratorPage = lazy(() => import('../pages/app/code-generator/CodeGeneratorPage'))
const ProjectsPage = lazy(() => import('../pages/app/projects/ProjectsPage'))
const ApplicationPage = lazy(() => import('../pages/app/application/ApplicationPage'))
const TestsWorkspacePage = lazy(() => import('../pages/app/tests/TestsWorkspacePage'))
const MobileTestingPage = lazy(() => import('../pages/app/mobile/MobileTestingPage'))
const ExecutionListPage = lazy(() => import('../pages/app/execution/ExecutionListPage'))
const ExecutionDetailPage = lazy(() => import('../pages/app/execution/ExecutionDetailPage'))
const ExecutionReportPage = lazy(() => import('../pages/app/execution/ExecutionReportPage'))
const HealingPage = lazy(() => import('../pages/app/healing/HealingPage'))
const ReportsPage = lazy(() => import('../pages/app/reports/ReportsPage'))
const IntegrationsPage = lazy(() => import('../pages/app/integrations/IntegrationsPage'))
const SettingsPage = lazy(() => import('../pages/app/settings/SettingsPage'))

export default function AppRouter() {
  return (
    <Routes>
      <Route element={<MarketingLayout />}>
        <Route path="/" element={<LandingPage />} />
      </Route>

      <Route
        path="/login"
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/create-account"
        element={
          <RedirectIfAuthenticated>
            <CreateAccountPage />
          </RedirectIfAuthenticated>
        }
      />

      <Route
        path="/app"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="command-center" element={<CommandCenterPage />} />
        <Route path="one-click-test" element={<OneClickTestPage />} />
        <Route path="code-generator" element={<CodeGeneratorPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="application" element={<ApplicationPage />} />
        <Route path="tests" element={<TestsWorkspacePage />} />
        <Route path="mobile" element={<MobileTestingPage />} />
        <Route path="execution" element={<ExecutionListPage />} />
        <Route path="execution/:id" element={<ExecutionDetailPage />} />
        <Route path="execution/:id/report" element={<ExecutionReportPage />} />
        <Route path="healing" element={<HealingPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={<NotFoundPage homeHref="/app/command-center" homeLabel="Back to Command Center" />}
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
