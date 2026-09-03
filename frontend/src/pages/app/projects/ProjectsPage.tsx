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
import type { Project } from '../../../lib/types'
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
      setName('')
      setDescription('')
      setCreateOpen(false)
      triggerToast(`Project "${project.name}" created.`)
    } catch (error) {
      setFormError((error as Error).message)
    } finally {
      setCreating(false)
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

                    <Link
                      to={`/app/projects/${project.id}/traceability`}
                      className="mt-2 font-mono text-xs text-accent hover:underline"
                    >
                      View traceability →
                    </Link>

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

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New project">
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
            <Button variant="outline" marker={false} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
