#!/usr/bin/env bash
# One-time, read-only export from the currently authenticated 教务宝 browser session.
#
# Usage:
#   scripts/jiaowubao-one-time-browser-export.sh /absolute/output/directory
#
# The output contains customer data. Keep it outside Git, do not commit it, and
# delete it when the controlled import/test is complete.
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "Usage: $0 /absolute/output/directory" >&2
  exit 64
fi

JWB_EXPORT_DIR="$1"
JWB_EXPORT_CONFIG='/private/tmp/jiaowubao-one-time-export-output-path'
umask 077
printf '%s\n' "$JWB_EXPORT_DIR" > "$JWB_EXPORT_CONFIG"
trap 'rm -f /private/tmp/jiaowubao-one-time-export-output-path' EXIT

ego-browser nodejs <<'EOF'
const fs = await import('node:fs/promises')
const path = await import('node:path')

const outputDir = (await fs.readFile('/private/tmp/jiaowubao-one-time-export-output-path', 'utf8')).trim()
const host = 'https://www.jwbpro.com'
const pageSize = 100
const pageConcurrency = 6

if (!outputDir || !path.isAbsolute(outputDir)) {
  throw new Error('JWB_EXPORT_DIR must be an absolute path')
}

const task = await useOrCreateTaskSpace('教务宝一次性资料导出')
await openOrReuseTab(`${host}/admin/#/studentList`, { wait: true, timeout: 25 })

async function writeJson(relativePath, value) {
  const destination = path.join(outputDir, relativePath)
  const temporary = `${destination}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, destination)
}

async function readJsonIfPresent(relativePath) {
  try {
    return JSON.parse(await fs.readFile(path.join(outputDir, relativePath), 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function numeric(value, label) {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a non-negative integer`)
  }
  return parsed
}

// All requests execute inside the authenticated browser page. No cookie or
// token is logged, written, passed in argv, or included in the manifest.
async function postApi(apiPath, body) {
  return (await postApiBatch(apiPath, [body]))[0]
}

async function postApiBatch(apiPath, bodies) {
  const endpoint = new URL(apiPath, host).toString()
  const results = await js(`(async () => Promise.all(${JSON.stringify(bodies)}.map(async (body) => {
    const response = await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(body),
    })
    const text = await response.text()
    return { status: response.status, text }
  })))()`)

  return results.map((result) => {
    if (result.status !== 200) throw new Error(`${apiPath} returned HTTP ${result.status}`)

    let parsed
    try {
      parsed = JSON.parse(result.text)
    } catch {
      throw new Error(`${apiPath} returned non-JSON data`)
    }

    if (String(parsed?.ret) !== '1') {
      throw new Error(`${apiPath} was rejected: ${parsed?.err_msg || parsed?.err_type || 'unknown error'}`)
    }
    return parsed
  })
}

const browserIdentity = await js(`(() => {
  const cookie = Object.fromEntries(document.cookie.split(';').map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? [part.trim(), ''] : [part.slice(0, index).trim(), part.slice(index + 1)]
  }))
  return { branchId: decodeURIComponent(cookie.branch || '') }
})()`)

if (!browserIdentity.branchId) {
  throw new Error('教务宝 branch cookie is unavailable; sign in again in the browser, then retry')
}

const branchId = browserIdentity.branchId
const manifest = {
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  source: '教务宝 authenticated browser session',
  pageSize,
  sources: {},
  notCollected: {
    lpTasks: 'Current organization had no visible task records; endpoint requires a separate mission-service contract.',
    followUpsReportsAndExamResults: 'Current inspected sources showed no records; do not fabricate empty exports as business data.',
    liveAndRecordingHistory: 'The organization has not enabled 教务宝 live streaming and the inspected lists were empty.',
    payroll: 'The signed-in account does not have 教务宝工资管理 read permission.',
    teacherAvailabilityAndCapacity: '教务宝 has no structured AVA, current teaching authorization, or capacity source.',
  },
}

async function exportPaged(spec) {
  const sourceDir = `sources/${spec.name}`
  const pageOnePath = `${sourceDir}/page-0001.json`
  let first = await readJsonIfPresent(pageOnePath)
  if (!first) {
    first = await postApi(spec.apiPath, { ...spec.baseBody, page: '1', limit: String(pageSize) })
    await writeJson(pageOnePath, first)
  }

  const total = numeric(spec.total(first), `${spec.name}.total`)
  const firstRows = spec.rows(first)
  if (!Array.isArray(firstRows)) throw new Error(`${spec.name} response did not contain an array of rows`)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  manifest.sources[spec.name] = { apiPath: spec.apiPath, total, pages, format: 'raw-page-json' }
  await writeJson('manifest.json', manifest)
  cliLog(`${spec.name}: ${total} rows across ${pages} page(s)`)

  const missingPages = []
  for (let page = 1; page <= pages; page += 1) {
    const relativePath = `${sourceDir}/page-${String(page).padStart(4, '0')}.json`
    if (!(await readJsonIfPresent(relativePath))) missingPages.push(page)
  }

  async function fetchPageBatch(pagesToFetch) {
    try {
      return await postApiBatch(spec.apiPath, pagesToFetch.map((page) => ({
        ...spec.baseBody, page: String(page), limit: String(pageSize),
      })))
    } catch (error) {
      if (pagesToFetch.length === 1) throw error
      const middle = Math.ceil(pagesToFetch.length / 2)
      cliLog(`${spec.name}: retrying pages ${pagesToFetch[0]}-${pagesToFetch.at(-1)} in smaller batches`)
      return [
        ...(await fetchPageBatch(pagesToFetch.slice(0, middle))),
        ...(await fetchPageBatch(pagesToFetch.slice(middle))),
      ]
    }
  }

  for (let index = 0; index < missingPages.length; index += pageConcurrency) {
    const batch = missingPages.slice(index, index + pageConcurrency)
    const payloads = await fetchPageBatch(batch)
    for (let offset = 0; offset < batch.length; offset += 1) {
      const page = batch[offset]
      const payload = payloads[offset]
      const rows = spec.rows(payload)
      if (!Array.isArray(rows)) throw new Error(`${spec.name} page ${page} did not contain rows`)
      await writeJson(`${sourceDir}/page-${String(page).padStart(4, '0')}.json`, payload)
    }
    const lastPage = batch.at(-1)
    if (lastPage === pages || lastPage % 25 < pageConcurrency) cliLog(`${spec.name}: saved through page ${lastPage}/${pages}`)
  }
}

async function exportSingle(spec) {
  const relativePath = `sources/${spec.name}.json`
  let payload = await readJsonIfPresent(relativePath)
  if (!payload) {
    payload = await postApi(spec.apiPath, spec.body)
    await writeJson(relativePath, payload)
  }
  manifest.sources[spec.name] = { apiPath: spec.apiPath, format: 'raw-json' }
  await writeJson('manifest.json', manifest)
  cliLog(`${spec.name}: saved`)
}

await fs.mkdir(outputDir, { recursive: true, mode: 0o700 })

await exportSingle({
  name: 'teachers',
  apiPath: '/api/teacher/list/',
  body: { branch_id: branchId, isAll: 'true' },
})
await exportSingle({
  name: 'courses',
  apiPath: '/api/course/list/',
  body: { branch_id: branchId, type: '0', position: 'layout_2' },
})
await exportSingle({
  name: 'classes',
  apiPath: '/api/class/list/',
  body: { branch_id: branchId, only_title: '1', type: '-1' },
})

await exportPaged({
  name: 'students',
  apiPath: '/api/mem/list/index_web.php',
  baseBody: {
    branch_id: branchId, keyword: '', types: '[]', no_team_types: '[]', team_id: '', is_wx: '', is_con: '',
    is_les: '', is_les_start: '', is_les_end: '', con_over: '', is_ks: '', rest_birth: '', birth_start: '',
    birth_end: '', rest_course_display: '0', order: '0', teacher_id: '', teacher_add: '', add_start: '', add_end: '',
    grade: '', zhuanshan_grade: '', zhuanshan_lesson: '', zhuanshan_lesson_teacher: '', course_id: '', rest_course_id: '',
  },
  total: (payload) => payload?.data?.total,
  rows: (payload) => payload?.data?.lists,
})
await exportPaged({
  name: 'contracts',
  apiPath: '/api/contract/list/',
  baseBody: { branch_id: branchId, pay_all: '1', del: '0' },
  total: (payload) => payload?.data?.total,
  rows: (payload) => payload?.data?.lists,
})
await exportPaged({
  name: 'schedule',
  apiPath: '/api/cal/list/',
  baseBody: {
    branch_id: branchId, team_id: '', teacher_id: '', mem_id: '', course_id: '', week: '-1',
    start: '2021-01-01', end: '2029-12-31', over: '-1', appoint: '-1', cal_type: '', check_conflict: '1', room_id: '',
  },
  total: (payload) => payload?.data?.total,
  rows: (payload) => payload?.data?.lists,
})
await exportPaged({
  name: 'leave_makeup',
  apiPath: '/api/cal/leave_list/',
  baseBody: {
    branch_id: branchId, teacher_id: '', deal_teacher_id: '', mem_id: '', leave_type: '0', is_deal: '', state: '0',
    cal_start: '2021-01-01', cal_end: '2029-12-31',
  },
  total: (payload) => payload?.data?.total,
  rows: (payload) => payload?.data?.lists,
})

manifest.completedAt = new Date().toISOString()
await writeJson('manifest.json', manifest)
cliLog(`Completed read-only export to ${outputDir}`)
EOF
