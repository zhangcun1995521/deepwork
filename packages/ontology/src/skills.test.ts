/**
 * Tests for offering a domain's vouched-for experience as skills.
 *
 * The claim being pinned is narrow and worth stating plainly: the set of skills equals the set a
 * read returns. Both come from `default_state`, so a candidate is in neither, and a domain
 * cannot end up handing an agent experience that nobody upheld.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadGraph } from './engine/graph.ts'
import { experienceSkills, toSkillName } from './skills.ts'

const example = (name: string): string =>
  fileURLToPath(new URL(`../examples/${name}`, import.meta.url))

/** The registry's rule for a skill name, quoted from its own contract. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

test('only what somebody upheld becomes loadable', () => {
  const { skills, notes } = experienceSkills(loadGraph(example('lessons')))

  // LES-001 is verified, LES-002 is a candidate and LES-003 was rejected. A read returns the
  // first alone, and so does this — asked of the same declaration.
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['lesson-les-001'],
  )
  assert.deepEqual(notes, [])
})

test('a skill carries what the declaration named, not what the engine guessed', () => {
  const [skill] = experienceSkills(loadGraph(example('lessons'))).skills
  const graph = loadGraph(example('lessons'))
  const lesson = graph.byId.get('Lesson:LES-001')?.data

  assert.equal(skill?.description, lesson?.rule)
  assert.equal(skill?.content, lesson?.rule)
  assert.equal(skill?.whenToUse, lesson?.applies_to)
  assert.equal(skill?.source, 'runtime', 'a runtime contribution, not a file on disk')
  assert.equal(
    skill?.name === undefined ? false : SKILL_NAME.test(skill.name),
    true,
    'the registry rejects a name outside its own grammar',
  )
})

test('a type that declares no skill exposes none, however many instances it has', () => {
  // `project-delivery` has 16 instances and no `skill` declaration; nothing about having data
  // makes it experience worth handing over.
  const { skills } = experienceSkills(loadGraph(example('project-delivery')))
  assert.deepEqual(skills, [])
})

test('an id that is not name-shaped is adapted rather than rejected', () => {
  assert.equal(toSkillName('Lesson', 'LES-001'), 'lesson-les-001')
  // Nothing constrains an id, so the name is derived rather than assumed.
  assert.equal(toSkillName('Test Pattern', 'PAT_Review:001'), 'test-pattern-pat-review-001')
  // An id with no alphanumerics in it at all leaves the type name on its own. Recorded rather
  // than guarded against: two such ids under one type would want the same name and the registry
  // would keep one of them, which is a real limit and a pathological input at the same time.
  assert.equal(toSkillName('X', '--'), 'x')
})

test('a vouched-for object missing a named field is reported, not silently dropped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deepwork-skills-'))
  cpSync(example('lessons'), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // The declaration is sound; this instance has not got the field it names.
  const file = join(root, 'objects', 'lessons', 'LES-001.yaml')
  writeFileSync(file, readFileSync(file, 'utf-8').replace(/^rule: [\s\S]*$/m, 'rule: ""'))

  const { skills, notes } = experienceSkills(loadGraph(root))
  assert.deepEqual(skills, [])
  assert.equal(notes.length, 1)
  assert.match(notes[0] ?? '', /LES-001 is in "verified" but its/)
})

test('a skill naming a field the type does not have is a problem, not a skill', () => {
  // `broken` declares one defect per rejection path; this is the skill path's.
  const graph = loadGraph(fileURLToPath(new URL('../tests/fixtures/broken', import.meta.url)))
  const reported = graph.warnings.join('\n')

  assert.match(reported, /"skill" names fields mounts_typo, which the type does not declare/)
  assert.equal(graph.schema.objectTypes.get('Widget')?.skill, undefined)
})

test('a routing field holding a list is rendered, not dropped in silence', (t) => {
  // A routing dimension is naturally a set of tags, so a domain naming one names a list. Dropping
  // it would leave the declaration saying the note is there and every skill without it — the one
  // failure this module reports rather than hides.
  const root = mkdtempSync(join(tmpdir(), 'deepwork-skills-'))
  cpSync(example('lessons'), root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const schema = join(root, 'schema.yaml')
  writeFileSync(
    schema,
    readFileSync(schema, 'utf-8').replace(
      'applies_to: { type: string }',
      'applies_to: { type: "list[string]" }',
    ),
  )
  const lesson = join(root, 'objects', 'lessons', 'LES-001.yaml')
  writeFileSync(
    lesson,
    readFileSync(lesson, 'utf-8').replace(
      /^applies_to: .*$/m,
      'applies_to: [artifact:pull_request, role:checker]',
    ),
  )

  const { skills, notes } = experienceSkills(loadGraph(root))

  assert.deepEqual(notes, [])
  assert.equal(skills[0]?.whenToUse, 'artifact:pull_request, role:checker')
})
