import { lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
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
const MobileTestLayout = lazy(() => import('../pages/app/mobile/MobileTestLayout'))
const MobileAppsPage = lazy(() => import('../pages/app/mobile/MobileAppsPage'))
const MobileDevicesPage = lazy(() => import('../pages/app/mobile/MobileDevicesPage'))
const MobileAuthorPage = lazy(() => import('../pages/app/mobile/MobileAuthorPage'))
const MobileExecutionsPage = lazy(() => import('../pages/app/mobile/MobileExecutionsPage'))
const MobileCompatibilityPage = lazy(() => import('../pages/app/mobile/MobileCompatibilityPage'))
const MobileSuiteRunPage = lazy(() => import('../pages/app/mobile/MobileSuiteRunPage'))
const MobileExecutionReportPage = lazy(() => import('../pages/app/mobile/MobileExecutionReportPage'))
const ExecutionListPage = lazy(() => import('../pages/app/execution/ExecutionListPage'))
const ExecutionDetailPage = lazy(() => import('../pages/app/execution/ExecutionDetailPage'))
const ExecutionReportPage = lazy(() => import('../pages/app/execution/ExecutionReportPage'))
const ReleasesPage = lazy(() => import('../pages/app/releases/ReleasesPage'))
const ReleaseDetailPage = lazy(() => import('../pages/app/releases/ReleaseDetailPage'))
const SprintDetailPage = lazy(() => import('../pages/app/releases/SprintDetailPage'))
const ProjectTraceabilityPage = lazy(() => import('../pages/app/projects/ProjectTraceabilityPage'))
const HealingPage = lazy(() => import('../pages/app/healing/HealingPage'))
const ReportsPage = lazy(() => import('../pages/app/reports/ReportsPage'))
const ReleaseReadinessPage = lazy(() => import('../pages/app/reports/ReleaseReadinessPage'))
const ReleaseComparisonPage = lazy(() => import('../pages/app/reports/ReleaseComparisonPage'))
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
        <Route path="mobile" element={<MobileTestLayout />}>
          <Route index element={<Navigate to="apps" replace />} />
          <Route path="apps" element={<MobileAppsPage />} />
          <Route path="devices" element={<MobileDevicesPage />} />
          <Route path="author" element={<MobileAuthorPage />} />
          <Route path="executions" element={<MobileExecutionsPage />} />
          <Route path="executions/:suiteId" element={<MobileSuiteRunPage />} />
          <Route path="executions/:id/report" element={<MobileExecutionReportPage />} />
          <Route path="compatibility" element={<MobileCompatibilityPage />} />
        </Route>
        <Route path="releases" element={<ReleasesPage />} />
        <Route path="releases/:releaseId" element={<ReleaseDetailPage />} />
        <Route path="releases/:releaseId/sprints/:sprintId" element={<SprintDetailPage />} />
        <Route path="projects/:projectId/traceability" element={<ProjectTraceabilityPage />} />
        <Route path="execution" element={<ExecutionListPage />} />
        <Route path="execution/:id" element={<ExecutionDetailPage />} />
        <Route path="execution/:id/report" element={<ExecutionReportPage />} />
        <Route path="healing" element={<HealingPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reports/release-readiness" element={<ReleaseReadinessPage />} />
        <Route path="reports/release-comparison" element={<ReleaseComparisonPage />} />
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
