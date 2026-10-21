import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Check, FolderKanban, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Input } from '../../../components/ui/Input'
import { Modal } from '../../../components/ui/Modal'
import { PageHeader } from '../../../components/ui/PageHeader'
import { Skeleton } from '../../../components/ui/Skeleton'
import { Textarea } from '../../../components/ui/Textarea'
import { api } from '../../../lib/api'
import type { Project, Release } from '../../../lib/types'
import { ALL_PROJECTS, useData } from '../../../contexts/DataContext'
import { useToast } from '../../../contexts/ToastContext'

export default function ProjectsPage() {
  const { projects, projectsLoading, loadProjects, activeProject, setActiveProject } = useData()
  const { triggerToast } = useToast()
  const location = useLocation()
  const navigate = useNavigate()

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Guided onboarding: New Project -> Create Release -> Create Sprint, each
  // step skippable. `wizardProject`/`wizardRelease` hold what's been created
  // so far this run of the wizard, driving which step renders next.
  const [wizardStep, setWizardStep] = useState<'project' | 'release' | 'sprint'>('project')
  const [wizardProject, setWizardProject] = useState<Project | null>(null)
  const [wizardRelease, setWizardRelease] = useState<Release | null>(null)
  const [releaseName, setReleaseName] = useState('')
  const [releaseDescription, setReleaseDescription] = useState('')
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [creatingRelease, setCreatingRelease] = useState(false)
  const [sprintName, setSprintName] = useState('')
  const [sprintError, setSprintError] = useState<string | null>(null)
  const [creatingSprint, setCreatingSprint] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // The topbar project menu links here with this flag to open the form directly.
  useEffect(() => {
    if ((location.state as { openCreate?: boolean } | null)?.openCreate) {
      setCreateOpen(true)
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.state, location.pathname, navigate])

  async function createProject(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      setFormError('Enter a project name.')
      return
    }
    setFormError(null)
    setCreating(true)
    try {
      const project = await api.createProject(name.trim(), description.trim() || undefined)
      await loadProjects()
      setActiveProject(project)
      setWizardProject(project)
      setWizardStep('release')
    } catch (error) {
      setFormError((error as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function createReleaseStep(event: FormEvent) {
    event.preventDefault()
    if (!wizardProject) return
    if (!releaseName.trim()) {
      setReleaseError('Enter a release name.')
      return
    }
    setReleaseError(null)
    setCreatingRelease(true)
    try {
      const release = await api.createRelease({
        projectId: wizardProject.id,
        name: releaseName.trim(),
        description: releaseDescription.trim() || undefined,
      })
      setWizardRelease(release)
      setWizardStep('sprint')
    } catch (error) {
      setReleaseError((error as Error).message)
    } finally {
      setCreatingRelease(false)
    }
  }

  async function createSprintStep(event: FormEvent) {
    event.preventDefault()
    if (!wizardRelease) return
    if (!sprintName.trim()) {
      setSprintError('Enter a sprint name.')
      return
    }
    setSprintError(null)
    setCreatingSprint(true)
    try {
      await api.createSprint({ releaseId: wizardRelease.id, name: sprintName.trim() })
      closeWizard(`Project "${wizardProject?.name}" is set up with release "${wizardRelease.name}" and sprint "${sprintName.trim()}".`)
    } catch (error) {
      setSprintError((error as Error).message)
    } finally {
      setCreatingSprint(false)
    }
  }

  /** Ends the wizard wherever it currently is — via "Skip" at any step, or
   *  after the sprint step completes. Whatever was already created (project,
   *  and possibly a release) is kept; nothing is rolled back. */
  function closeWizard(toastMessage?: string) {
    const project = wizardProject
    const release = wizardRelease
    setCreateOpen(false)
    setWizardStep('project')
    setWizardProject(null)
    setWizardRelease(null)
    setName('')
    setDescription('')
    setReleaseName('')
    setReleaseDescription('')
    setReleaseError(null)
    setSprintName('')
    setSprintError(null)
    if (toastMessage) {
      triggerToast(toastMessage)
    } else if (release) {
      triggerToast(`Project "${project?.name}" created with release "${release.name}". Add a sprint anytime from Releases.`)
    } else if (project) {
      triggerToast(`Project "${project.name}" created. Add a release anytime from Releases.`)
    }
  }

  function startEditing(project: Project) {
    setEditingId(project.id)
    setEditName(project.name)
    setEditDescription(project.description ?? '')
  }

  function cancelEditing() {
    setEditingId(null)
    setEditName('')
    setEditDescription('')
  }

  async function saveEdit(projectId: string) {
    if (!editName.trim()) {
      triggerToast('Project name cannot be empty.', true)
      return
    }
    setSavingEdit(true)
    try {
      const updated = await api.updateProject(projectId, editName.trim(), editDescription.trim())
      await loadProjects()
      if (activeProject?.id === projectId) setActiveProject(updated)
      triggerToast('Project updated.')
      cancelEditing()
    } catch (error) {
      triggerToast(`Update failed: ${(error as Error).message}`, true)
    } finally {
      setSavingEdit(false)
    }
  }

  async function deleteProject(project: Project) {
    // Cascades server-side through suites, executions and their artifacts.
    const confirmed = window.confirm(
      `Delete "${project.name}"? This also removes its test suites, executions and reports. This cannot be undone.`,
    )
    if (!confirmed) return

    setDeletingId(project.id)
    try {
      await api.deleteProject(project.id)
      const remaining = projects.filter((p) => p.id !== project.id)
      await loadProjects()
      if (activeProject?.id === project.id) {
        setActiveProject(remaining[0] ?? ALL_PROJECTS)
      }
      triggerToast('Project deleted.')
    } catch (error) {
      triggerToast(`Delete failed: ${(error as Error).message}`, true)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Workspaces that own your test suites, runs and integrations."
        actions={<Button onClick={() => setCreateOpen(true)}>New Project</Button>}
      />

      {projectsLoading && projects.length === 0 ? (
        <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-36 w-full rounded-card" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="A project holds your test suites, executions and integration settings. Create one to get started."
          action={<Button onClick={() => setCreateOpen(true)}>New Project</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const isActive = activeProject?.id === project.id
            const isEditing = editingId === project.id

            return (
              <Card key={project.id} className="flex flex-col p-5">
                {isEditing ? (
                  <div className="flex flex-1 flex-col gap-3">
                    <Input
                      label="Name"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                    />
                    <Textarea
                      label="Description"
                      rows={3}
                      value={editDescription}
                      onChange={(event) => setEditDescription(event.target.value)}
                    />
                    <div className="mt-auto flex gap-2">
                      <Button
                        marker={false}
                        disabled={savingEdit}
                        onClick={() => void saveEdit(project.id)}
                        className="px-3 py-1.5 text-xs"
                      >
                        <Check size={14} aria-hidden="true" />
                        {savingEdit ? 'Saving…' : 'Save'}
                      </Button>
                      <Button
                        variant="outline"
                        marker={false}
                        onClick={cancelEditing}
                        className="px-3 py-1.5 text-xs"
                      >
                        <X size={14} aria-hidden="true" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="min-w-0 truncate font-sans text-base font-semibold text-ink">
                        {project.name}
                      </h2>
                      {isActive && (
                        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-xs text-accent-deep">
                          Active
                        </span>
                      )}
                    </div>

                    <p className="mt-1.5 line-clamp-3 flex-1 text-sm text-ink-soft">
                      {project.description || 'No description.'}
                    </p>

                    <p className="mt-3 font-mono text-xs text-muted">
                      Created {new Date(project.createdAt).toLocaleDateString()}
                    </p>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      <Link
                        to={`/app/projects/${project.id}/traceability`}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        View traceability →
                      </Link>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveProject(project)
                          navigate('/app/releases')
                        }}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        Manage releases →
                      </button>
                    </div>

                    <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
                      {!isActive && (
                        <Button
                          variant="outline"
                          marker={false}
                          onClick={() => setActiveProject(project)}
                          className="px-3 py-1.5 text-xs"
                        >
                          Set active
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEditing(project)}
                        aria-label={`Rename ${project.name}`}
                        title="Rename"
                        className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-paper hover:text-ink"
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === project.id}
                        onClick={() => void deleteProject(project)}
                        aria-label={`Delete ${project.name}`}
                        title="Delete"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-ink-soft hover:bg-fail/10 hover:text-fail disabled:opacity-40"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => closeWizard()}
        title={
          wizardStep === 'project'
            ? 'New project'
            : wizardStep === 'release'
              ? 'Create your first release'
              : 'Create your first sprint'
        }
      >
        {wizardStep === 'project' && (
          <form onSubmit={createProject} noValidate className="flex flex-col gap-4">
            <Input
              label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              error={formError ?? undefined}
            />
            <Textarea
              label="Description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              helperText="Optional."
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" marker={false} onClick={() => closeWizard()}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        )}

        {wizardStep === 'release' && (
          <form onSubmit={createReleaseStep} noValidate className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              A release groups the sprints and test runs for "{wizardProject?.name}". You can add more later.
            </p>
            <Input
              label="Release name"
              value={releaseName}
              onChange={(event) => setReleaseName(event.target.value)}
              error={releaseError ?? undefined}
              placeholder="e.g. v1.0"
            />
            <Textarea
              label="Description"
              rows={3}
              value={releaseDescription}
              onChange={(event) => setReleaseDescription(event.target.value)}
              helperText="Optional."
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" marker={false} onClick={() => closeWizard()}>
                Skip for now
              </Button>
              <Button type="submit" disabled={creatingRelease}>
                {creatingRelease ? 'Creating…' : 'Create release'}
              </Button>
            </div>
          </form>
        )}

        {wizardStep === 'sprint' && (
          <form onSubmit={createSprintStep} noValidate className="flex flex-col gap-4">
            <p className="text-sm text-ink-soft">
              A sprint is where you'll assign test cases and track runs within "{wizardRelease?.name}".
            </p>
            <Input
              label="Sprint name"
              value={sprintName}
              onChange={(event) => setSprintName(event.target.value)}
              error={sprintError ?? undefined}
              placeholder="e.g. Sprint 1"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" marker={false} onClick={() => closeWizard()}>
                Skip for now
              </Button>
              <Button type="submit" disabled={creatingSprint}>
                {creatingSprint ? 'Creating…' : 'Create sprint'}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
