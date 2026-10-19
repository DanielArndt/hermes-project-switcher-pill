/**
 * Project Switcher Pill — shows the current project/workspace just above (or
 * inside) the chat composer, with a dropdown to switch projects or start a new
 * chat in another project.
 *
 * Resolves projects and their owning profiles across all profiles via
 * `profiles.list` + `projects.list` + `projects.tree`, matches the focused
 * session's workspace (`host.state.cwd`) or active project pointer (`active_id`),
 * and automatically switches to the owning profile when starting a new session
 * in a project from the composer pill.
 *
 * Plain ESM loaded at runtime by Hermes Desktop — uses jsx/jsxs from
 * react/jsx-runtime and imports exclusively from @hermes/plugin-sdk.
 */

import {
  atom,
  Button,
  cn,
  Codicon,
  COMPOSER_AREAS,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  haptic,
  host,
  ListRow,
  queryClient,
  SegmentedControl,
  Tip,
  ToggleRow,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

const ID = 'project-switcher-pill'
const NO_PROJECT_ID = '__no_project__'
const ALL_PROJECTS = '__all_projects__'
const PROJECT_SCOPE_STORAGE_KEY = 'hermes.desktop.projectScope'
const WORKSPACE_CWD_STORAGE_KEY = 'hermes.desktop.workspace-cwd'
const DISMISSED_AUTO_STORAGE_KEY = 'hermes.desktop.dismissedAutoProjects'

const DEFAULT_PREFS = {
  area: 'above', // 'above' | 'top' | 'actions' | 'leading'
  activeChatAction: 'move', // 'move' | 'new-chat'
  showAutoProjects: true,
  showSessionCounts: true
}

const ABOVE_CLEANUP_CSS = `
/* Collapse the bottom underside strip's top padding when it only holds our above-composer pill */
[data-slot='composer-dock'] > div.pt-1\\.5:has(> [data-project-pill-above]):not(:has(> :not([data-project-pill-above]))) {
  padding-top: 0 !important;
}
`

function syncAboveStripCss(enabled) {
  if (typeof document === 'undefined') return
  const styleId = 'hermes-plugin-project-switcher-pill-style'
  let el = document.getElementById(styleId)
  if (!enabled) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = styleId
    document.head.appendChild(el)
  }
  if (el.textContent !== ABOVE_CLEANUP_CSS) {
    el.textContent = ABOVE_CLEANUP_CSS
  }
}

// Optimistic override for the current cwd/project when the user switches on a
// fresh draft or before the gateway event round-trips back to host.state.cwd.
const $optimisticSelection = atom(null)
const $sessionCwdMap = atom({})
const $explicitProjects = atom([])
const $knownProjects = atom([])

function normalizeProfile(name) {
  const val = String(name ?? '').trim()
  return val || 'default'
}

function normalizePath(raw) {
  let path = String(raw || '')
    .trim()
    .replace(/\\/g, '/')
  if (!path) return ''
  if (path.startsWith('//')) {
    path = '//' + path.slice(2).replace(/\/{2,}/g, '/')
  } else {
    path = path.replace(/\/{2,}/g, '/')
  }
  if (path.length > 1 && path.endsWith('/') && !/^[A-Za-z]:\/$/.test(path)) {
    path = path.replace(/\/+$/, '')
  }
  return path
}

function isWindowsPath(path) {
  return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\') || path.startsWith('//')
}

function comparisonSegments(path) {
  const clean = String(path || '')
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .map(seg => seg.normalize('NFC'))
  return isWindowsPath(String(path || '')) ? clean.map(s => s.toLowerCase()) : clean
}

function pathKey(path) {
  return comparisonSegments(path).join('/')
}

function isPathUnder(folder, target) {
  const f = comparisonSegments(folder)
  const t = comparisonSegments(target)
  if (!f.length || f.length > t.length) return false
  return f.every((seg, i) => seg === t[i])
}

function displayPath(raw) {
  const path = normalizePath(raw)
  if (!path) return ''
  if (path === '~' || path.startsWith('~/')) return path

  const match =
    path.match(/^(\/Users\/[^/]+)(?:\/|$)/) ||
    path.match(/^(\/home\/[^/]+)(?:\/|$)/) ||
    path.match(/^([A-Za-z]:\/Users\/[^/]+)(?:\/|$)/)

  if (!match) return path
  const home = match[1]
  if (path.length === home.length) return '~'
  return `~${path.slice(home.length)}`
}

function isHomeDirectoryCwd(raw) {
  const d = displayPath(raw)
  return d === '~' || d === '/' || d === '/home' || d === '/Users'
}

function pathLeaf(raw) {
  const path = normalizePath(raw)
  if (!path || path === '/' || path === '~') return path
  if (/^[A-Za-z]:\/?$/.test(path)) return path.endsWith('/') ? path : `${path}/`
  const leaf = path.split('/').filter(Boolean).pop()
  return leaf || path
}

function readDismissedAutoProjects() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_AUTO_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function readStoredProjectScope() {
  try {
    return window.localStorage.getItem(PROJECT_SCOPE_STORAGE_KEY) || ALL_PROJECTS
  } catch {
    return ALL_PROJECTS
  }
}

function writeStoredProjectScope(projectId) {
  try {
    const val = projectId || ALL_PROJECTS
    window.localStorage.setItem(PROJECT_SCOPE_STORAGE_KEY, val)
  } catch {
    // Ignore storage errors
  }
}

function writeStoredWorkspaceCwd(cwd, profileName) {
  try {
    const clean = String(cwd || '').trim()
    const prof = normalizeProfile(profileName)
    const key =
      prof === 'default'
        ? WORKSPACE_CWD_STORAGE_KEY
        : `${WORKSPACE_CWD_STORAGE_KEY}.profile.${encodeURIComponent(prof)}`
    if (clean) {
      window.localStorage.setItem(WORKSPACE_CWD_STORAGE_KEY, clean)
      window.localStorage.setItem(key, clean)
    } else {
      window.localStorage.removeItem(WORKSPACE_CWD_STORAGE_KEY)
      window.localStorage.removeItem(key)
    }
  } catch {
    // Ignore storage errors
  }
}

function projectRootCwd(project) {
  if (!project || project.isNoProject) return ''
  const primary = String(project.path || project.primary_path || '').trim()
  if (primary) return primary
  if (Array.isArray(project.repos)) {
    const repoWithPath = project.repos.find(r => String(r?.path || '').trim())
    if (repoWithPath) return String(repoWithPath.path).trim()
  }
  if (Array.isArray(project.folders)) {
    const primaryFolder = project.folders.find(f => f?.is_primary && String(f?.path || '').trim())
    if (primaryFolder) return String(primaryFolder.path).trim()
    const firstFolder = project.folders.find(f => String(f?.path || '').trim())
    if (firstFolder) return String(firstFolder.path).trim()
  }
  return ''
}

function collectProjectPaths(project) {
  if (!project || project.isNoProject) return []
  const paths = []
  if (project.path) paths.push(project.path)
  if (project.primary_path) paths.push(project.primary_path)
  if (Array.isArray(project.folders)) {
    for (const f of project.folders) {
      if (f?.path) paths.push(f.path)
    }
  }
  if (Array.isArray(project.repos)) {
    for (const repo of project.repos) {
      if (repo?.path) paths.push(repo.path)
      if (Array.isArray(repo?.groups)) {
        for (const group of repo.groups) {
          if (group?.path) paths.push(group.path)
        }
      }
    }
  }
  return paths.map(p => String(p || '').trim()).filter(Boolean)
}

function matchProjectForCwd(cwd, projects) {
  const target = String(cwd || '').trim()
  if (!target) return null

  let best = null
  let bestLen = -1
  let bestExplicit = false

  for (const project of projects) {
    if (!project || project.isNoProject || project.archived) continue
    const isExplicit = !project.isAuto
    const paths = collectProjectPaths(project)

    for (const p of paths) {
      if (isPathUnder(p, target)) {
        const len = comparisonSegments(p).length
        if (len > bestLen || (len === bestLen && isExplicit && !bestExplicit)) {
          bestLen = len
          best = project
          bestExplicit = isExplicit
        }
      }
    }
  }

  return best
}

function resolveOwnerProfileForProject(project, fallbackPath = '') {
  if (project?.isNoProject || project?.id === NO_PROJECT_ID) {
    return 'default'
  }
  const direct = String(project?.ownerProfile || project?.profile || '').trim()
  if (direct) {
    return normalizeProfile(direct)
  }

  const explicitList = $explicitProjects.get()
  if (project?.id) {
    const byId = explicitList.find(p => p.id === project.id)
    if (byId?.ownerProfile) {
      return normalizeProfile(byId.ownerProfile)
    }
  }

  const candidatePath = String(fallbackPath || projectRootCwd(project) || '').trim()
  if (candidatePath) {
    const byPath = matchProjectForCwd(candidatePath, explicitList)
    if (byPath?.ownerProfile) {
      return normalizeProfile(byPath.ownerProfile)
    }
  }

  return null
}

function matchProjectForSessionId(sessionId, projects) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null

  for (const project of projects) {
    if (!project) continue
    if (Array.isArray(project.sessionIds) && project.sessionIds.includes(sid)) {
      return project
    }
    if (
      Array.isArray(project.previewSessions) &&
      project.previewSessions.some(s => s?.id === sid || s?._lineage_root_id === sid)
    ) {
      return project
    }
  }
  return null
}

function ingestSessionCwdRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return
  const prev = $sessionCwdMap.get()
  let next = prev

  const put = (id, cwd) => {
    if (!id) return
    const val = String(cwd || '').trim()
    if (next[id] !== val) {
      if (next === prev) next = { ...prev }
      next[id] = val
    }
  }

  for (const s of rows) {
    if (!s || typeof s !== 'object') continue
    const cwd = String(s.cwd || s.git_repo_root || '').trim()
    if (s.id) put(s.id, cwd)
    if (s.resolved_id) put(s.resolved_id, cwd)
    if (s._lineage_root_id) put(s._lineage_root_id, cwd)
  }

  if (next !== prev) {
    $sessionCwdMap.set(next)
  }
}

async function listAllProfileNames(activeProfile) {
  const names = new Set(['default'])
  if (activeProfile) names.add(normalizeProfile(activeProfile))

  try {
    const rpc = await host.request('profiles.list', { include_sessions: false }).catch(() => null)
    if (Array.isArray(rpc?.profiles)) {
      for (const p of rpc.profiles) {
        if (p?.name) names.add(normalizeProfile(p.name))
      }
    }
  } catch {
    // Ignore
  }

  if (names.size <= 1 && typeof host.profiles?.list === 'function') {
    try {
      const res = await host.profiles.list()
      if (Array.isArray(res?.profiles)) {
        for (const p of res.profiles) {
          if (p?.name) names.add(normalizeProfile(p.name))
        }
      }
    } catch {
      // Ignore
    }
  }

  return [...names]
}

async function fetchProjectDirectoryData(activeProfile) {
  const prof = normalizeProfile(activeProfile || host.state.focusedSessionProfile?.get?.() || host.state.profile?.get?.())
  const profileNames = await listAllProfileNames(prof)

  // Query default first, then other profiles, and activeProfile last if duplicate IDs exist
  const orderedProfiles = [
    ...profileNames.filter(n => n === 'default' && n !== prof),
    ...profileNames.filter(n => n !== 'default' && n !== prof),
    prof
  ]

  const [treeRes, ...listResults] = await Promise.all([
    host.request('projects.tree', { preview_limit: 3, profile: prof }).catch(() => null),
    ...orderedProfiles.map(pName =>
      host
        .request('projects.list', { profile: pName })
        .then(res => ({ profile: pName, res }))
        .catch(() => ({ profile: pName, res: null }))
    )
  ])

  const explicitById = new Map()
  let activeIdFromOwner = null

  for (const { profile: ownerProfile, res } of listResults) {
    if (ownerProfile === prof && res?.active_id) {
      activeIdFromOwner = res.active_id
    }
    if (Array.isArray(res?.projects)) {
      for (const p of res.projects) {
        if (p && p.id && !p.archived) {
          explicitById.set(p.id, {
            ...p,
            ownerProfile
          })
        }
      }
    }
  }

  const nextExplicitList = [...explicitById.values()]
  $explicitProjects.set(nextExplicitList)

  const dismissed = readDismissedAutoProjects()
  const merged = []
  const seenIds = new Set()
  const seenPathKeys = new Set()

  const treeNodes = Array.isArray(treeRes?.projects) ? treeRes.projects : []
  for (const node of treeNodes) {
    if (!node || !node.id || node.archived) continue
    if (node.isAuto && dismissed.has(node.id)) continue

    if (Array.isArray(node.previewSessions)) {
      ingestSessionCwdRows(node.previewSessions)
    }

    const explicit =
      explicitById.get(node.id) ||
      (node.path ? matchProjectForCwd(node.path, nextExplicitList) : null)

    const rootPath = node.path || explicit?.primary_path || explicit?.folders?.[0]?.path || null
    const ownerProfile = node.isNoProject
      ? 'default'
      : explicit?.ownerProfile || (node.profile ? normalizeProfile(node.profile) : null)

    const item = {
      id: explicit && node.isAuto ? explicit.id : node.id,
      label: node.isNoProject
        ? 'Home'
        : String(
            (explicit && node.isAuto ? explicit.name : node.label) ||
              explicit?.name ||
              pathLeaf(rootPath) ||
              node.id
          ),
      path: rootPath,
      color: node.color ?? explicit?.color ?? null,
      icon: node.icon ?? explicit?.icon ?? null,
      isAuto: explicit ? false : Boolean(node.isAuto),
      isNoProject: Boolean(node.isNoProject),
      ownerProfile,
      sessionCount: typeof node.sessionCount === 'number' ? node.sessionCount : 0,
      lastActive: typeof node.lastActive === 'number' ? node.lastActive : 0,
      repos: Array.isArray(node.repos) ? node.repos : [],
      folders: Array.isArray(explicit?.folders) ? explicit.folders : [],
      sessionIds: Array.isArray(node.sessionIds) ? node.sessionIds : [],
      previewSessions: Array.isArray(node.previewSessions) ? node.previewSessions : []
    }

    seenIds.add(item.id)
    if (rootPath) seenPathKeys.add(pathKey(rootPath))
    merged.push(item)
  }

  for (const [id, p] of explicitById.entries()) {
    const rootPath = p.primary_path || p.folders?.[0]?.path || null
    if (seenIds.has(id) || (rootPath && seenPathKeys.has(pathKey(rootPath)))) continue
    seenIds.add(id)
    if (rootPath) seenPathKeys.add(pathKey(rootPath))
    merged.push({
      id: p.id,
      label: String(p.name || pathLeaf(rootPath) || p.id),
      path: rootPath,
      color: p.color ?? null,
      icon: p.icon ?? null,
      isAuto: false,
      isNoProject: false,
      ownerProfile: p.ownerProfile || 'default',
      sessionCount: 0,
      lastActive: p.updated_at || p.created_at || 0,
      repos: [],
      folders: Array.isArray(p.folders) ? p.folders : [],
      sessionIds: [],
      previewSessions: []
    })
  }

  $knownProjects.set(merged)

  const activeId = treeRes?.active_id ?? activeIdFromOwner ?? null

  return {
    projects: merged,
    activeId
  }
}

function useProjectDirectory() {
  const gatewayState = useValue(host.state.gateway)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const gatewayProfile = useValue(host.state.profile)
  const activeProfile = normalizeProfile(focusedProfile || gatewayProfile)

  return useQuery({
    queryKey: [ID, 'projects', gatewayState, activeProfile],
    queryFn: async () => {
      if (gatewayState !== 'open') {
        return { projects: $knownProjects.get(), activeId: null }
      }
      return fetchProjectDirectoryData(activeProfile)
    },
    staleTime: 8_000,
    refetchInterval: 15_000
  })
}

function ProjectGlyph({ project, size = '0.75rem' }) {
  if (!project) {
    return jsx(Codicon, {
      className: 'shrink-0 text-(--ui-text-tertiary)',
      name: 'folder-library',
      size
    })
  }

  const color = project.color || null
  const iconName =
    project.icon ||
    (project.isNoProject ? 'home' : project.isAuto ? 'repo' : 'folder-library')

  if (color && !project.icon && !project.isNoProject) {
    return jsxs('span', {
      className: 'inline-flex shrink-0 items-center justify-center',
      style: { color },
      children: [jsx(Codicon, { className: 'shrink-0', name: iconName, size })]
    })
  }

  return jsx(Codicon, {
    className: cn('shrink-0', !color && 'text-(--ui-text-tertiary)'),
    name: iconName,
    size,
    style: color ? { color } : undefined
  })
}

function sortProjects(projects, activeId, showAutoProjects) {
  const filtered = projects.filter(p => {
    if (!p) return false
    if (p.isNoProject) return false
    if (p.isAuto && !showAutoProjects) return false
    return true
  })

  return [...filtered].sort((a, b) => {
    const aActive = Boolean(activeId && a.id === activeId && !a.isAuto)
    const bActive = Boolean(activeId && b.id === activeId && !b.isAuto)
    if (aActive !== bActive) return aActive ? -1 : 1

    if (!a.isAuto !== !b.isAuto) return a.isAuto ? 1 : -1

    const aHas = (a.sessionCount || 0) > 0
    const bHas = (b.sessionCount || 0) > 0
    if (aHas !== bHas) return aHas ? -1 : 1

    const byTime = (b.lastActive || 0) - (a.lastActive || 0)
    if (byTime !== 0) return byTime

    return String(a.label || '').localeCompare(String(b.label || ''), undefined, {
      sensitivity: 'base'
    })
  })
}

let cancelPendingProjectCwd = null

function applyDraftWorkspaceCwd(targetPath, targetId, targetProfile, preserveSidebarScope = false) {
  if (typeof cancelPendingProjectCwd === 'function') {
    cancelPendingProjectCwd()
    cancelPendingProjectCwd = null
  }

  const cwd = String(targetPath || '').trim()
  const prof = normalizeProfile(targetProfile)
  const scopeVal = preserveSidebarScope
    ? readStoredProjectScope()
    : cwd
      ? targetId && targetId !== ALL_PROJECTS && targetId !== NO_PROJECT_ID
        ? targetId
        : cwd
      : NO_PROJECT_ID

  writeStoredProjectScope(scopeVal)
  writeStoredWorkspaceCwd(cwd, prof)

  let resolvedCwd = cwd
  let disposed = false
  let reapplying = false

  const apply = () => {
    if (disposed || reapplying) return
    if (host.state.activeSessionId?.get?.()) return
    reapplying = true
    try {
      if (typeof host.state.cwd?.set === 'function') {
        const current = String(host.state.cwd?.get?.() ?? '').trim()
        if (current !== resolvedCwd) {
          host.state.cwd.set(resolvedCwd)
        }
      }
      writeStoredProjectScope(scopeVal)
      writeStoredWorkspaceCwd(resolvedCwd, prof)
    } finally {
      reapplying = false
    }
  }

  apply()

  const unlisten =
    typeof host.state.cwd?.listen === 'function'
      ? host.state.cwd.listen(nextVal => {
          if (disposed || reapplying) return
          if (host.state.activeSessionId?.get?.()) return
          const trimmed = String(nextVal ?? '').trim()
          if (resolvedCwd ? !trimmed : trimmed) {
            apply()
          }
        })
      : null

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(apply)
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      apply()
      requestAnimationFrame(apply)
    })
  }

  const timers = [0, 20, 60, 150, 350, 600].map(ms => window.setTimeout(apply, ms))
  const cleanupTimer = window.setTimeout(() => {
    if (typeof cancelPendingProjectCwd === 'function') {
      cancelPendingProjectCwd()
    }
  }, 850)

  cancelPendingProjectCwd = () => {
    if (disposed) return
    disposed = true
    if (typeof unlisten === 'function') unlisten()
    for (const t of timers) window.clearTimeout(t)
    window.clearTimeout(cleanupTimer)
  }

  if (!cwd) {
    return
  }

  void host
    .request('config.get', {
      key: 'project',
      cwd,
      ...(prof ? { profile: prof } : {})
    })
    .then(info => {
      if (disposed) return
      if (info?.cwd && typeof info.cwd === 'string' && info.cwd.trim()) {
        resolvedCwd = info.cwd.trim()
        apply()
      }
    })
    .catch(() => null)
}

async function openNewSessionInProject(targetPath, targetProfile, targetId, preserveSidebarScope = false) {
  const cwd = String(targetPath || '').trim()
  const prof = normalizeProfile(targetProfile)

  let draftText = null
  if (typeof host.composer?.getDraft === 'function') {
    try {
      draftText = await host.composer.getDraft(null)
    } catch {
      draftText = null
    }
  }

  host.newChat(prof)
  applyDraftWorkspaceCwd(cwd, targetId, prof, preserveSidebarScope)

  if (draftText && typeof host.composer?.setDraft === 'function') {
    window.setTimeout(() => {
      void host.composer.setDraft('new', draftText).catch(() => null)
    }, 30)
  }

  return true
}

// The gateway is often a long-lived background service with no display session
// in its environment, so a bare `code` starts, finds no display and exits
// silently. Rebuild the display env first (prefer Wayland, fall back to X11).
// Sent as plain shell (shell.exec already runs through a shell) because the
// gateway's safety filter rejects `sh -c ...`.
const VSCODE_LAUNCH_SCRIPT = [
  'rt="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
  'export XDG_RUNTIME_DIR="$rt"',
  'flags=""',
  'if [ -z "$WAYLAND_DISPLAY" ]; then WAYLAND_DISPLAY=$(ls "$rt" 2>/dev/null | grep -E "^wayland-[0-9]+$" | head -1); fi',
  'if [ -n "$WAYLAND_DISPLAY" ] && [ -S "$rt/$WAYLAND_DISPLAY" ]; then export WAYLAND_DISPLAY; unset DISPLAY; flags="--ozone-platform=wayland"',
  'elif [ -z "$DISPLAY" ]; then x=$(ls /tmp/.X11-unix 2>/dev/null | grep -E "^X[0-9]+$" | head -1); [ -n "$x" ] && export DISPLAY=":${x#X}"; fi',
  'nohup code $flags -- "$1" >/dev/null 2>&1 &'
].join('\n')

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

// Resolve branch + worktree facts for a folder. `git-dir` differs from
// `git-common-dir` only inside a linked worktree.
async function fetchGitContext(cwd) {
  const q = shellQuote(cwd)
  const res = await host
    .request('shell.exec', {
      command: `git -C ${q} rev-parse --show-toplevel --abbrev-ref HEAD --absolute-git-dir --path-format=absolute --git-common-dir 2>/dev/null`
    })
    .catch(() => null)
  const lines = String(res?.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (res?.code !== 0 || lines.length < 4) return null
  const [root, branch, gitDir, commonDir] = lines
  return {
    root,
    branch: branch === 'HEAD' ? '' : branch,
    isLinkedWorktree: normalizePath(gitDir) !== normalizePath(commonDir)
  }
}

// Opens the focused chat's folder in VS Code. Since a worktree session's cwd is
// the worktree directory itself, opening the cwd opens the right branch checkout.
function OpenInVSCodeButton({ cwd, placement }) {
  const [opening, setOpening] = useState(false)
  const target = String(cwd || '').trim()
  const enabled = Boolean(target) && !isHomeDirectoryCwd(target)

  const { data: git } = useQuery({
    queryKey: [ID, 'git', target],
    queryFn: () => fetchGitContext(target),
    enabled,
    staleTime: 10_000,
    refetchInterval: 20_000
  })

  if (!enabled) return null

  const detail = git?.branch
    ? `${git.branch}${git.isLinkedWorktree ? ' · worktree' : ''}`
    : ''
  const label = `Open ${displayPath(target)}${detail ? ` (${detail})` : ''} in VS Code`

  const open = async () => {
    if (opening) return
    haptic('tap')
    setOpening(true)
    try {
      const res = await host.request('shell.exec', {
        command: `set -- ${shellQuote(target)}\n${VSCODE_LAUNCH_SCRIPT}`
      })
      if (res?.code && res.code !== 0) {
        throw new Error(String(res.stderr || 'code exited with an error').trim())
      }
    } catch (err) {
      host.notifyError?.(err, 'Failed to open VS Code')
    } finally {
      setTimeout(() => setOpening(false), 600)
    }
  }

  const isAbove = placement === 'above'

  return jsx(Tip, {
    label,
    side: 'top',
    children: jsx(Button, {
      'aria-label': label,
      className: cn(
        isAbove
          ? 'h-(--composer-control-size) shrink-0 gap-1.5 rounded-full border border-border/65 bg-(--composer-fill) px-2.5 text-xs font-normal backdrop-blur-[0.75rem] [-webkit-backdrop-filter:blur(0.75rem)]'
          : 'h-(--composer-control-size) shrink-0 gap-1.5 rounded-md px-2 text-xs font-normal',
        'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      disabled: opening,
      onClick: () => {
        void open()
      },
      type: 'button',
      variant: 'ghost',
      children: [
        jsx(Codicon, { key: 'icon', name: 'vscode', size: '0.8rem' }),
        git?.branch
          ? jsx(
              'span',
              {
                className: 'max-w-32 truncate font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                children: git.branch
              },
              'branch'
            )
          : null
      ]
    })
  })
}

function ProjectSelectorPill({ placement, prefsAtom }) {
  const prefs = useValue(prefsAtom)
  const rawCwd = useValue(host.state.cwd)
  const focusedSessionId = useValue(host.state.focusedSessionId)
  const activeSessionId = useValue(host.state.activeSessionId)
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const gatewayProfile = useValue(host.state.profile)
  const busy = useValue(host.state.busy)
  const optimistic = useValue($optimisticSelection)
  const sessionCwdMap = useValue($sessionCwdMap)

  const [switching, setSwitching] = useState(false)

  const activeProfile = normalizeProfile(focusedProfile || gatewayProfile)
  const runtimeSessionId = focusedSessionId || activeSessionId || null
  const storedSessionId = focusedStoredId || null
  const isFreshDraft = !runtimeSessionId && !storedSessionId

  const { data, refetch } = useProjectDirectory()
  const projects = data?.projects || []
  const activeProjectId = data?.activeId || null

  const sessionKey = storedSessionId || runtimeSessionId || '__draft__'

  // Clear optimistic selection when session context changes or live cwd catches up
  useEffect(() => {
    if (!optimistic) return
    if (optimistic.sessionKey !== sessionKey) {
      $optimisticSelection.set(null)
      return
    }
    if (optimistic.cwd && rawCwd && normalizePath(rawCwd) === normalizePath(optimistic.cwd)) {
      $optimisticSelection.set(null)
    }
  }, [optimistic, sessionKey, rawCwd])

  // Determine the effective cwd for the focused chat
  const effectiveCwd = (() => {
    if (optimistic && optimistic.sessionKey === sessionKey) {
      return optimistic.cwd ?? ''
    }
    const live = String(rawCwd || '').trim()
    if (live) return live
    if (storedSessionId && sessionCwdMap[storedSessionId] !== undefined) {
      return sessionCwdMap[storedSessionId]
    }
    return ''
  })()

  // Resolve the current project
  const currentProject = (() => {
    if (
      optimistic &&
      optimistic.sessionKey === sessionKey &&
      optimistic.projectId
    ) {
      if (optimistic.projectId === NO_PROJECT_ID) {
        return (
          projects.find(p => p.isNoProject) || {
            id: NO_PROJECT_ID,
            label: 'Home',
            path: null,
            isNoProject: true
          }
        )
      }
      const match = projects.find(p => p.id === optimistic.projectId)
      if (match) return match
    }

    if (effectiveCwd) {
      const byCwd = matchProjectForCwd(effectiveCwd, projects)
      if (byCwd) return byCwd
      if (isHomeDirectoryCwd(effectiveCwd)) {
        return (
          projects.find(p => p.isNoProject) || {
            id: NO_PROJECT_ID,
            label: 'Home',
            path: null,
            isNoProject: true
          }
        )
      }
      return {
        id: effectiveCwd,
        label: pathLeaf(effectiveCwd),
        path: effectiveCwd,
        isAuto: true,
        isNoProject: false
      }
    }

    if (storedSessionId) {
      const bySession = matchProjectForSessionId(storedSessionId, projects)
      if (bySession) return bySession
    }

    if (isFreshDraft) {
      const scopeId = readStoredProjectScope()
      if (scopeId === NO_PROJECT_ID) {
        return (
          projects.find(p => p.isNoProject) || {
            id: NO_PROJECT_ID,
            label: 'Home',
            path: null,
            isNoProject: true
          }
        )
      }
      if (scopeId && scopeId !== ALL_PROJECTS) {
        const scoped = projects.find(p => p.id === scopeId)
        if (scoped) return scoped
      }
      if (activeProjectId) {
        const activeProj = projects.find(p => p.id === activeProjectId)
        if (activeProj) return activeProj
      }
    }

    return (
      projects.find(p => p.isNoProject) || {
        id: NO_PROJECT_ID,
        label: 'Home',
        path: null,
        isNoProject: true
      }
    )
  })()

  const homeProject = projects.find(p => p.isNoProject) || {
    id: NO_PROJECT_ID,
    label: 'Home',
    path: null,
    isNoProject: true,
    ownerProfile: 'default',
    sessionCount: 0
  }

  const sortedProjects = sortProjects(
    projects,
    activeProjectId,
    prefs.showAutoProjects !== false
  )

  const handleSelectProject = async (targetProject, event) => {
    if (switching || busy) return
    haptic('selection')

    const isNoProject = Boolean(targetProject?.isNoProject || targetProject?.id === NO_PROJECT_ID)
    const targetId = isNoProject ? NO_PROJECT_ID : targetProject.id
    const targetPath = isNoProject ? '' : projectRootCwd(targetProject)
    const ownerProfile =
      resolveOwnerProfileForProject(targetProject, targetPath) ||
      (isNoProject ? 'default' : activeProfile)

    const forceNewChat =
      Boolean(event?.metaKey || event?.ctrlKey || event?.shiftKey) ||
      (!isFreshDraft && prefs.activeChatAction === 'new-chat')

    if (!forceNewChat && currentProject?.id === targetId && (!isFreshDraft || ownerProfile === activeProfile)) {
      return
    }

    setSwitching(true)
    try {
      // 1. Update persisted active project pointer for explicit projects
      if (isNoProject) {
        writeStoredProjectScope(NO_PROJECT_ID)
        await host
          .request('projects.set_active', { id: null, profile: ownerProfile })
          .catch(() => null)
      } else {
        writeStoredProjectScope(targetId)
        if (String(targetId).startsWith('p_')) {
          await host
            .request('projects.set_active', { id: targetId, profile: ownerProfile })
            .catch(() => null)
        }
      }

      // 2. Switch workspace or start a new chat
      if (forceNewChat) {
        $optimisticSelection.set({
          sessionKey: '__draft__',
          profile: ownerProfile,
          projectId: targetId,
          cwd: targetPath
        })
        await openNewSessionInProject(targetPath, ownerProfile, targetId, false)
      } else if (!isFreshDraft && (storedSessionId || runtimeSessionId)) {
        const moveTargetCwd = isNoProject ? '~' : targetPath
        if (moveTargetCwd) {
          $optimisticSelection.set({
            sessionKey,
            profile: activeProfile,
            projectId: targetId,
            cwd: isNoProject ? '' : moveTargetCwd
          })

          let moved = false
          if (storedSessionId) {
            try {
              const res = await host.request('session.workspace.move', {
                session_key: storedSessionId,
                cwd: moveTargetCwd,
                profile: activeProfile
              })
              const resolvedCwd = res?.cwd || moveTargetCwd
              ingestSessionCwdRows([{ id: storedSessionId, cwd: resolvedCwd }])
              if (resolvedCwd && typeof host.state.cwd?.set === 'function') {
                host.state.cwd.set(resolvedCwd)
              }
              moved = true
            } catch {
              // Fall back to session.cwd.set below
            }
          }

          if (!moved && runtimeSessionId) {
            const res = await host.request('session.cwd.set', {
              session_id: runtimeSessionId,
              cwd: moveTargetCwd
            })
            const resolvedCwd = res?.cwd || moveTargetCwd
            if (storedSessionId && resolvedCwd) {
              ingestSessionCwdRows([{ id: storedSessionId, cwd: resolvedCwd }])
            }
            if (resolvedCwd && typeof host.state.cwd?.set === 'function') {
              host.state.cwd.set(resolvedCwd)
            }
            moved = true
          }

          if (moved) {
            host.notify({
              durationMs: 2_000,
              kind: 'info',
              message: `Switched project to ${isNoProject ? 'Home' : targetProject.label}`
            })
          }
        }
      } else {
        // Fresh draft: anchor the draft to the target project's workspace & switch to its owning profile
        $optimisticSelection.set({
          sessionKey,
          profile: ownerProfile,
          projectId: targetId,
          cwd: targetPath
        })
        await openNewSessionInProject(targetPath, ownerProfile, targetId, false)
      }

      await queryClient.invalidateQueries({ queryKey: [ID, 'projects'] })
    } catch (err) {
      $optimisticSelection.set(null)
      host.notifyError?.(err, `Failed to switch to project "${targetProject?.label || targetId}"`)
    } finally {
      setSwitching(false)
    }
  }

  const handleOpenFolderAsProject = async () => {
    if (switching || busy) return
    haptic('tap')

    const selectPaths = window.hermesDesktop?.selectPaths
    if (typeof selectPaths !== 'function') {
      host.notify({
        kind: 'warning',
        message: 'Native folder picker is unavailable in this environment.'
      })
      return
    }

    try {
      const picked = await selectPaths({
        directories: true,
        multiple: false,
        ...(activeProfile ? { profile: activeProfile } : {})
      })
      const folder = Array.isArray(picked) && picked[0] ? String(picked[0]).trim() : ''
      if (!folder) return

      setSwitching(true)
      const existing = matchProjectForCwd(folder, projects)
      if (existing && !existing.isAuto) {
        await handleSelectProject(existing)
        return
      }

      const name = pathLeaf(folder) || folder
      const createdRes = await host
        .request('projects.create', {
          name,
          folders: [folder],
          primary_path: folder,
          use: true,
          profile: activeProfile
        })
        .catch(() => null)

      const created = createdRes?.project
      const nextProject = created
        ? {
            id: created.id,
            label: created.name || name,
            path: created.primary_path || folder,
            color: created.color || null,
            icon: created.icon || null,
            isAuto: false,
            isNoProject: false,
            ownerProfile: activeProfile
          }
        : {
            id: folder,
            label: name,
            path: folder,
            isAuto: true,
            isNoProject: false,
            ownerProfile: activeProfile
          }

      await handleSelectProject(nextProject)
    } catch (err) {
      host.notifyError?.(err, 'Failed to open folder as project')
    } finally {
      setSwitching(false)
    }
  }

  const isAbove = placement === 'above'
  const isTopBanner = placement === 'top'
  const currentLabel = currentProject?.label || 'Home'
  const currentPathDisplay = currentProject?.path ? displayPath(currentProject.path) : ''

  const triggerButton = jsx(Button, {
    'aria-label': `Current project: ${currentLabel}`,
    className: cn(
      isAbove
        ? 'h-(--composer-control-size) min-w-0 max-w-64 shrink gap-1.5 rounded-full border border-border/65 bg-(--composer-fill) px-2.5 text-xs font-normal backdrop-blur-[0.75rem] [-webkit-backdrop-filter:blur(0.75rem)]'
        : isTopBanner
          ? 'h-6 w-full justify-between rounded-md px-2 text-xs font-medium'
          : 'h-(--composer-control-size) min-w-0 shrink gap-1.5 rounded-md px-2 text-xs font-normal',
      'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground',
      'data-[state=open]:bg-(--ui-control-active-background) data-[state=open]:text-foreground'
    ),
    disabled: busy || switching,
    onPointerEnter: () => {
      void refetch()
    },
    type: 'button',
    variant: 'ghost',
    children: jsxs('span', {
      className: cn(
        'flex min-w-0 items-center gap-1.5 overflow-hidden',
        isTopBanner && 'w-full justify-between'
      ),
      children: [
        jsxs('span', {
          className: 'flex min-w-0 items-center gap-1.5 overflow-hidden',
          children: [
            jsx(ProjectGlyph, { project: currentProject, size: '0.8rem' }),
            jsx('span', {
              className: 'truncate font-medium text-foreground/90',
              children: currentLabel
            }),
            (isTopBanner || isAbove) &&
              currentPathDisplay &&
              jsx('span', {
                className: 'truncate font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                children: currentPathDisplay
              })
          ]
        }),
        jsx(Codicon, {
          className: 'shrink-0 opacity-50',
          name: 'chevron-down',
          size: '0.7rem'
        })
      ]
    })
  })

  const actionVerb =
    isFreshDraft || prefs.activeChatAction === 'move'
      ? 'switch project for this chat'
      : 'start a new chat in another project'

  const tooltipText = currentPathDisplay
    ? `Project: ${currentLabel} (${currentPathDisplay}) — click to ${actionVerb}`
    : `Project: ${currentLabel} (No workspace folder) — click to ${actionVerb}`

  const headerText = isFreshDraft
    ? 'Switch Project for This Chat'
    : prefs.activeChatAction === 'move'
      ? 'Move Chat to Project (⌘/⇧-Click for New Chat)'
      : 'Start New Chat in Project'

  const isHomeSelected = Boolean(
    currentProject?.isNoProject || currentProject?.id === NO_PROJECT_ID
  )

  const dropdown = jsx(DropdownMenu, {
    children: [
      jsx(
        Tip,
        {
          label: tooltipText,
          side: 'top',
          children: jsx(DropdownMenuTrigger, {
            asChild: true,
            children: triggerButton
          })
        },
        'trigger'
      ),
      jsxs(
        DropdownMenuContent,
        {
          align: placement === 'actions' ? 'end' : 'start',
          className: 'min-w-60 max-w-80 max-h-96 overflow-y-auto',
          collisionPadding: 8,
          side: 'top',
          sideOffset: 8,
          children: [
            jsx('div', {
              className:
                'px-2.5 pt-1.5 pb-1 text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
              children: headerText
            }),
            jsx(DropdownMenuSeparator, {}),
            // Home (No project folder) row
            jsx(
              DropdownMenuItem,
              {
                className: 'flex items-center justify-between gap-2',
                onSelect: event => {
                  void handleSelectProject(homeProject, event)
                },
                children: [
                  jsxs('span', {
                    className: 'flex min-w-0 items-center gap-2 overflow-hidden',
                    children: [
                      jsx(ProjectGlyph, { project: homeProject, size: '0.85rem' }),
                      jsxs('span', {
                        className: 'flex min-w-0 flex-col',
                        children: [
                          jsx('span', {
                            className: cn(
                              'truncate text-xs',
                              isHomeSelected && 'font-medium text-foreground'
                            ),
                            children: 'Home'
                          }),
                          jsx('span', {
                            className: 'truncate text-[0.625rem] text-(--ui-text-tertiary)',
                            children: 'No workspace folder'
                          })
                        ]
                      })
                    ]
                  }),
                  isHomeSelected
                    ? jsx(Codicon, {
                        className: 'shrink-0 text-foreground',
                        name: 'check',
                        size: '0.75rem'
                      })
                    : null
                ]
              },
              NO_PROJECT_ID
            ),
            sortedProjects.length > 0 && jsx(DropdownMenuSeparator, {}),
            ...sortedProjects.map(project => {
              const isCurrent =
                !isHomeSelected &&
                (currentProject?.id === project.id ||
                  (project.path &&
                    currentProject?.path &&
                    normalizePath(project.path) === normalizePath(currentProject.path)))
              const rootPath = projectRootCwd(project)
              const formattedPath = rootPath ? displayPath(rootPath) : ''
              const count = project.sessionCount || 0

              return jsx(
                DropdownMenuItem,
                {
                  className: 'flex items-center justify-between gap-2',
                  onSelect: event => {
                    void handleSelectProject(project, event)
                  },
                  children: [
                    jsxs('span', {
                      className: 'flex min-w-0 items-center gap-2 overflow-hidden',
                      children: [
                        jsx(ProjectGlyph, { project, size: '0.85rem' }),
                        jsxs('span', {
                          className: 'flex min-w-0 flex-col',
                          children: [
                            jsxs('span', {
                              className: 'flex items-center gap-1.5 min-w-0',
                              children: [
                                jsx('span', {
                                  className: cn(
                                    'truncate text-xs',
                                    isCurrent && 'font-medium text-foreground'
                                  ),
                                  children: project.label
                                }),
                                project.isAuto &&
                                  jsx('span', {
                                    className:
                                      'shrink-0 rounded bg-(--ui-control-active-background) px-1 py-px text-[0.5625rem] text-(--ui-text-tertiary)',
                                    children: 'repo'
                                  })
                              ]
                            }),
                            formattedPath &&
                              jsx('span', {
                                className:
                                  'truncate font-mono text-[0.625rem] text-(--ui-text-tertiary)',
                                children: formattedPath
                              })
                          ]
                        })
                      ]
                    }),
                    jsxs('span', {
                      className: 'flex shrink-0 items-center gap-1.5',
                      children: [
                        prefs.showSessionCounts !== false &&
                          count > 0 &&
                          !isCurrent &&
                          jsx('span', {
                            className: 'text-[0.625rem] tabular-nums text-(--ui-text-quaternary)',
                            children: String(count)
                          }),
                        isCurrent
                          ? jsx(Codicon, {
                              className: 'shrink-0 text-foreground',
                              name: 'check',
                              size: '0.75rem'
                            })
                          : !isFreshDraft && prefs.activeChatAction === 'new-chat'
                            ? jsx('span', {
                                className: 'shrink-0 text-[0.625rem] text-(--ui-text-tertiary)',
                                children: 'New chat'
                              })
                            : null
                      ]
                    })
                  ]
                },
                project.id
              )
            }),
            jsx(DropdownMenuSeparator, {}),
            jsx(DropdownMenuItem, {
              onSelect: () => {
                void handleOpenFolderAsProject()
              },
              children: jsxs('span', {
                className: 'flex items-center gap-2 text-(--ui-text-secondary)',
                children: [
                  jsx(Codicon, { name: 'folder-opened', size: '0.8rem' }),
                  jsx('span', { children: 'Open folder as project…' })
                ]
              })
            })
          ]
        },
        'content'
      )
    ]
  })

  const vscodeButton = jsx(OpenInVSCodeButton, { cwd: effectiveCwd, placement })

  if (isAbove) {
    return jsx('div', {
      'data-project-pill-above': '',
      className:
        'pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 flex w-full items-center px-[5px]',
      children: jsxs('div', {
        className: 'pointer-events-auto flex min-w-0 items-center gap-1.5',
        children: [dropdown, vscodeButton]
      })
    })
  }

  if (isTopBanner) {
    return jsxs('div', {
      className: 'flex w-full items-center gap-1',
      children: [jsx('div', { className: 'min-w-0 flex-1', children: dropdown }), vscodeButton]
    })
  }

  return jsxs(Fragment, { children: [dropdown, vscodeButton] })
}

export default {
  id: ID,
  name: 'Project Switcher Pill',
  description:
    'Displays the current project/workspace just above (or inside) the chat composer with a dropdown to switch projects or start a new chat in another project.',
  register(ctx) {
    const prefs = atom({ ...DEFAULT_PREFS, ...ctx.storage.get('prefs', {}) })

    syncAboveStripCss((prefs.get().area || 'above') === 'above')

    if (host.state.gateway?.get?.() === 'open') {
      void fetchProjectDirectoryData(
        host.state.focusedSessionProfile?.get?.() || host.state.profile?.get?.()
      ).catch(() => null)
    }

    ctx.onDispose?.(() => {
      syncAboveStripCss(false)
    })

    const updatePrefs = patch => {
      const next = { ...prefs.get(), ...patch }
      prefs.set(next)
      ctx.storage.set('prefs', next)
      syncAboveStripCss((next.area || 'above') === 'above')
    }

    const refreshProjectsQuery = () => {
      void fetchProjectDirectoryData(
        host.state.focusedSessionProfile?.get?.() || host.state.profile?.get?.()
      ).catch(() => null)
      void queryClient.invalidateQueries({ queryKey: [ID, 'projects'] })
    }

    ctx.onEvent('projects.changed', refreshProjectsQuery)
    ctx.onEvent('sessions.changed', refreshProjectsQuery)
    ctx.onEvent('session.info', event => {
      const payload = event?.payload
      if (payload && typeof payload.cwd === 'string') {
        if (payload.stored_session_id) {
          ingestSessionCwdRows([{ id: payload.stored_session_id, cwd: payload.cwd }])
        }
        refreshProjectsQuery()
      }
    })

    // "Above Chat Box" (default) mounts inside `composer.underside` (an unclipped
    // sibling of the composer inside `composer-dock`) and positions itself at
    // `bottom-full mb-1.5` right above the top edge of the chat box.
    ctx.register({
      id: 'composer-above-pill',
      area: COMPOSER_AREAS.underside,
      order: 5,
      render: function AboveSlot() {
        const { area } = useValue(prefs)
        if ((area || 'above') !== 'above') return null
        return jsx(ProjectSelectorPill, { placement: 'above', prefsAtom: prefs })
      }
    })

    ctx.register({
      id: 'composer-top-banner',
      area: COMPOSER_AREAS.top,
      order: 15,
      render: function TopSlot() {
        const { area } = useValue(prefs)
        if (area !== 'top') return null
        return jsx(ProjectSelectorPill, { placement: 'top', prefsAtom: prefs })
      }
    })

    ctx.register({
      id: 'composer-actions-pill',
      area: COMPOSER_AREAS.actions,
      order: 15,
      render: function ActionsSlot() {
        const { area } = useValue(prefs)
        if (area !== 'actions') return null
        return jsx(ProjectSelectorPill, { placement: 'actions', prefsAtom: prefs })
      }
    })

    ctx.register({
      id: 'composer-leading-pill',
      area: COMPOSER_AREAS.leading,
      order: 15,
      render: function LeadingSlot() {
        const { area } = useValue(prefs)
        if (area !== 'leading') return null
        return jsx(ProjectSelectorPill, { placement: 'leading', prefsAtom: prefs })
      }
    })

    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Project Switcher Pill',
      icon: 'folder-library',
      render: function SettingsView() {
        const currentPrefs = useValue(prefs)

        return jsx(Fragment, {
          children: [
            jsx(ListRow, {
              title: 'Composer position',
              description: 'Where to show the current project dropdown relative to the chat composer.',
              action: jsx(SegmentedControl, {
                value: currentPrefs.area || 'above',
                onChange: val => updatePrefs({ area: val }),
                options: [
                  { id: 'above', label: 'Above Chat Box' },
                  { id: 'top', label: 'Top Banner' },
                  { id: 'actions', label: 'Beside Model' },
                  { id: 'leading', label: 'Left (by +)' }
                ]
              })
            }),
            jsx(ListRow, {
              title: 'Switching during an active chat',
              description:
                'Whether selecting another project moves the current chat workspace or starts a new chat in that project (hold ⌘/Ctrl or Shift to always open a new chat).',
              action: jsx(SegmentedControl, {
                value: currentPrefs.activeChatAction || 'move',
                onChange: val => updatePrefs({ activeChatAction: val }),
                options: [
                  { id: 'move', label: 'Move Current Chat' },
                  { id: 'new-chat', label: 'Start New Chat' }
                ]
              })
            }),
            jsx(ToggleRow, {
              label: 'Show auto-discovered repositories',
              description:
                'Include Git repositories discovered from disk scans and session history alongside explicitly created projects.',
              checked: currentPrefs.showAutoProjects !== false,
              onChange: val => updatePrefs({ showAutoProjects: val })
            }),
            jsx(ToggleRow, {
              label: 'Show session counts',
              description: 'Display the number of sessions in each project inside the dropdown menu.',
              checked: currentPrefs.showSessionCounts !== false,
              onChange: val => updatePrefs({ showSessionCounts: val })
            })
          ]
        })
      }
    })
  }
}
