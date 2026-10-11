// Syncs .github/backlog/backlog.yml into GitHub: labels, sprint milestones,
// epic and story issues, epic -> story sub-issue links, assignees, and (when a
// PROJECT_TOKEN secret is available) the org Project board with Story Points,
// Sprint and Task Set fields.
//
// Runs inside actions/github-script. Issues are matched to backlog entries by a
// hidden "backlog-id" marker in the issue body, so re-running updates them in
// place instead of creating duplicates.

const fs = require('fs');
const path = require('path');

const MARKER = (id) => `<!-- backlog-id: ${id} -->`;
const MARKER_RE = /<!-- backlog-id: ([A-Z]-\d+) -->/;

module.exports = async ({ github, context, core, getOctokit, yaml }) => {
  const { owner, repo } = context.repo;
  const dryRun = process.env.DRY_RUN === 'true';
  const root = process.env.GITHUB_WORKSPACE;
  const backlog = yaml.load(fs.readFileSync(path.join(root, '.github/backlog/backlog.yml'), 'utf8'));
  const assignees = yaml.load(fs.readFileSync(path.join(root, '.github/backlog/assignees.yml'), 'utf8')) || {};

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (msg) => core.info(`${dryRun ? '[dry-run] ' : ''}${msg}`);

  // YAML parses bare dates as Date objects; keep them as YYYY-MM-DD strings.
  for (const s of backlog.sprints) {
    s.start = s.start instanceof Date ? s.start.toISOString().slice(0, 10) : String(s.start);
  }
  const sprints = Object.fromEntries(backlog.sprints.map((s) => [s.key, s]));
  const epics = Object.fromEntries(backlog.epics.map((e) => [e.id, e]));
  const managedLabels = new Set(backlog.labels.map((l) => l.name));
  const setLabel = (set) => (set === 'lead' ? 'set: lead' : `set: ${set.replace('m', '')}`);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const sprintEnd = (s) => {
    const d = new Date(`${s.start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + s.days - 1);
    return d;
  };
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const sprintRange = (s) => `${fmt(new Date(`${s.start}T00:00:00Z`))} - ${fmt(sprintEnd(s))}`;

  // ---------------------------------------------------------------- labels
  const existingLabels = new Map(
    (await github.paginate(github.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 })).map((l) => [l.name, l]),
  );
  for (const l of backlog.labels) {
    const cur = existingLabels.get(l.name);
    if (!cur) {
      log(`create label "${l.name}"`);
      if (!dryRun) await github.rest.issues.createLabel({ owner, repo, ...l });
    } else if (cur.color.toLowerCase() !== l.color.toLowerCase() || (cur.description || '') !== l.description) {
      log(`update label "${l.name}"`);
      if (!dryRun) await github.rest.issues.updateLabel({ owner, repo, ...l });
    }
  }

  // ------------------------------------------------------------ milestones
  const milestones = new Map(
    (await github.paginate(github.rest.issues.listMilestones, { owner, repo, state: 'all', per_page: 100 })).map((m) => [m.title, m]),
  );
  const milestoneNumber = {};
  for (const s of backlog.sprints) {
    const due_on = `${sprintEnd(s).toISOString().slice(0, 10)}T12:00:00Z`;
    const description = s.description;
    const cur = milestones.get(s.title);
    if (!cur) {
      log(`create milestone "${s.title}"`);
      if (!dryRun) {
        const { data } = await github.rest.issues.createMilestone({ owner, repo, title: s.title, description, due_on });
        milestoneNumber[s.key] = data.number;
      }
    } else {
      milestoneNumber[s.key] = cur.number;
      if ((cur.description || '') !== description || (cur.due_on || '').slice(0, 10) !== due_on.slice(0, 10)) {
        log(`update milestone "${s.title}"`);
        if (!dryRun) await github.rest.issues.updateMilestone({ owner, repo, milestone_number: cur.number, description, due_on });
      }
    }
  }

  // ---------------------------------------------------------------- issues
  const allIssues = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const byBacklogId = new Map();
  for (const i of allIssues) {
    if (i.pull_request) continue;
    const m = (i.body || '').match(MARKER_RE);
    if (m) byBacklogId.set(m[1], i);
  }

  // Keep checkboxes that people have already ticked when regenerating a body.
  const keepTicks = (newBody, oldBody) => {
    if (!oldBody) return newBody;
    const ticked = new Set(
      oldBody.split('\n').filter((l) => /^\s*- \[x\] /i.test(l)).map((l) => l.replace(/^\s*- \[x\] /i, '').trim()),
    );
    return newBody
      .split('\n')
      .map((l) => (/^- \[ \] /.test(l) && ticked.has(l.slice(6).trim()) ? l.replace('- [ ] ', '- [x] ') : l))
      .join('\n');
  };

  const upsert = async (id, { title, body, labels, milestone, assignee }) => {
    const cur = byBacklogId.get(id);
    if (!cur) {
      log(`create issue ${id}: ${title}`);
      if (dryRun) return { number: 0, id: 0, node_id: '', title };
      const { data } = await github.rest.issues.create({
        owner, repo, title, body, labels, milestone, assignees: assignee ? [assignee] : undefined,
      });
      byBacklogId.set(id, data);
      await sleep(1000); // stay clear of secondary rate limits on content creation
      return data;
    }
    const finalBody = keepTicks(body, cur.body);
    const otherLabels = cur.labels.map((l) => l.name).filter((n) => !managedLabels.has(n));
    const finalLabels = [...new Set([...labels, ...otherLabels])].sort();
    const curLabels = cur.labels.map((l) => l.name).sort();
    const patch = {};
    if (cur.title !== title) patch.title = title;
    if ((cur.body || '').trim() !== finalBody.trim()) patch.body = finalBody;
    if (JSON.stringify(curLabels) !== JSON.stringify(finalLabels)) patch.labels = finalLabels;
    if (milestone && cur.milestone?.number !== milestone) patch.milestone = milestone;
    if (assignee && !(cur.assignees.length === 1 && cur.assignees[0].login.toLowerCase() === assignee.toLowerCase())) {
      patch.assignees = [assignee];
    }
    if (Object.keys(patch).length) {
      log(`update issue #${cur.number} ${id}: ${Object.keys(patch).join(', ')}`);
      if (!dryRun) {
        const { data } = await github.rest.issues.update({ owner, repo, issue_number: cur.number, ...patch });
        byBacklogId.set(id, data);
        return data;
      }
    }
    return cur;
  };

  const epicTitle = (e) => `[EPIC ${e.id}] ${e.title}`;
  const storyTitle = (s) => `[${s.id}] ${s.title}`;
  const storiesOf = (epicId) => backlog.stories.filter((s) => s.epic === epicId);

  const epicBody = (e) => {
    const rows = storiesOf(e.id).map((s) => {
      const issue = byBacklogId.get(s.id);
      const ref = issue && issue.number ? `#${issue.number}` : s.id;
      return `| ${ref} | ${s.title} | ${s.points} | ${sprints[s.sprint].title} | ${backlog.sets[s.set]} |`;
    });
    const pts = storiesOf(e.id).reduce((a, s) => a + s.points, 0);
    return [
      e.description,
      '',
      `**Requirements:** ${e.refs.join(', ')}  `,
      `**Priority:** ${cap(e.priority)} · **Total story points:** ${pts}`,
      '',
      '### Stories',
      '| Issue | Story | Points | Sprint | Task set |',
      '|---|---|---|---|---|',
      ...rows,
      '',
      MARKER(e.id),
    ].join('\n');
  };

  const storyBody = (s) => {
    const e = epics[s.epic];
    const epicIssue = byBacklogId.get(e.id);
    const epicRef = epicIssue && epicIssue.number ? `#${epicIssue.number}` : e.id;
    const sp = sprints[s.sprint];
    return [
      `**Epic:** ${epicRef} ${e.title}  `,
      `**Sprint:** ${sp.title} (${sprintRange(sp)}) · **Story points:** ${s.points} · **Priority:** ${cap(s.priority)}  `,
      `**Task set:** ${backlog.sets[s.set]}  `,
      `**Requirements:** ${s.refs.join(', ')}`,
      '',
      '### User story',
      s.story,
      '',
      '### Acceptance criteria',
      ...s.acceptance.map((a) => `- [ ] ${a}`),
      '',
      '### Tasks',
      ...s.tasks.map((t) => `- [ ] ${t}`),
      '',
      '### Definition of done',
      '- Code and unit tests merged through a PR whose description says `Closes #<this issue>`',
      '- CI is green and the PR is reviewed and merged by the repo owner',
      '- Any deviation from the SRS, SADS or Test Plan is noted in `docs/DEVIATIONS.md`',
      '',
      MARKER(s.id),
    ].join('\n');
  };

  // Pass 1: epics (so stories can reference them).
  for (const e of backlog.epics) {
    await upsert(e.id, {
      title: epicTitle(e),
      body: epicBody(e),
      labels: ['epic', `priority: ${e.priority}`, `area: ${e.area}`],
    });
  }

  // Pass 2: stories.
  for (const s of backlog.stories) {
    const e = epics[s.epic];
    const labels = ['story', `priority: ${s.priority}`, `area: ${e.area}`, `points: ${s.points}`, setLabel(s.set)];
    await upsert(s.id, {
      title: storyTitle(s),
      body: storyBody(s),
      labels,
      milestone: milestoneNumber[s.sprint],
      assignee: (assignees[s.set] || '').trim() || undefined,
    });
  }

  // Pass 3: epic bodies now that story numbers exist, and sub-issue links.
  for (const e of backlog.epics) {
    const epicIssue = await upsert(e.id, {
      title: epicTitle(e),
      body: epicBody(e),
      labels: ['epic', `priority: ${e.priority}`, `area: ${e.area}`],
    });
    if (dryRun) continue;
    const linked = new Set(
      (await github.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        owner, repo, issue_number: epicIssue.number, per_page: 100,
      })).map((i) => i.number),
    );
    for (const s of storiesOf(e.id)) {
      const storyIssue = byBacklogId.get(s.id);
      if (linked.has(storyIssue.number)) continue;
      log(`link #${storyIssue.number} as sub-issue of #${epicIssue.number}`);
      await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        owner, repo, issue_number: epicIssue.number, sub_issue_id: storyIssue.id, replace_parent: true,
      });
    }
  }

  // --------------------------------------------------------------- project
  const projectToken = process.env.PROJECT_TOKEN;
  if (!projectToken) {
    core.warning('PROJECT_TOKEN secret is not set: skipped the Project board. Issues, labels and milestones are synced.');
    return;
  }
  if (dryRun) {
    log('would sync Project board');
    return;
  }
  const gql = getOctokit(projectToken).graphql;

  const { repository } = await gql(
    `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ id owner{ id login __typename } } }`,
    { owner, repo },
  );
  const ownerField = repository.owner.__typename === 'Organization' ? 'organization' : 'user';
  const found = await gql(
    `query($login:String!,$q:String!){ ${ownerField}(login:$login){ projectsV2(first:50, query:$q){ nodes{ id number title url repositories(first:20){ nodes{ id } } } } } }`,
    { login: repository.owner.login, q: backlog.project.title },
  );
  let project = found[ownerField].projectsV2.nodes.find((p) => p.title === backlog.project.title);
  if (!project) {
    log(`create project "${backlog.project.title}"`);
    const res = await gql(
      `mutation($ownerId:ID!,$title:String!,$repoId:ID!){ createProjectV2(input:{ownerId:$ownerId,title:$title,repositoryId:$repoId}){ projectV2{ id number title url } } }`,
      { ownerId: repository.owner.id, title: backlog.project.title, repoId: repository.id },
    );
    project = res.createProjectV2.projectV2;
    await gql(
      `mutation($id:ID!,$d:String!){ updateProjectV2(input:{projectId:$id, shortDescription:$d}){ projectV2{ id } } }`,
      { id: project.id, d: backlog.project.description },
    );
  } else if (!project.repositories.nodes.some((r) => r.id === repository.id)) {
    log('link project to repository');
    await gql(
      `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p, repositoryId:$r}){ repository{ id } } }`,
      { p: project.id, r: repository.id },
    );
  }
  core.notice(`Project board: ${project.url}`);

  const FIELDS_Q = `query($id:ID!){ node(id:$id){ ... on ProjectV2 { fields(first:50){ nodes{
    ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name } }
    ... on ProjectV2IterationField { configuration { iterations { id title } completedIterations { id title } } }
  } } } } }`;
  const getFields = async () => (await gql(FIELDS_Q, { id: project.id })).node.fields.nodes;
  let fields = await getFields();
  const field = (name) => fields.find((f) => f.name === name);

  const ensureField = async (name, input) => {
    if (field(name)) return;
    log(`create project field "${name}"`);
    await gql(
      `mutation($input:CreateProjectV2FieldInput!){ createProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2FieldCommon { id } } } }`,
      { input: { projectId: project.id, name, ...input } },
    );
  };
  await ensureField('Story Points', { dataType: 'NUMBER' });
  await ensureField('Sprint', {
    dataType: 'ITERATION',
    iterationConfiguration: {
      startDate: backlog.sprints[0].start,
      duration: backlog.sprints[0].days,
      iterations: backlog.sprints.map((s) => ({ title: s.title, startDate: s.start, duration: s.days })),
    },
  });
  const colors = ['GRAY', 'PURPLE', 'GREEN', 'YELLOW', 'BLUE', 'ORANGE'];
  await ensureField('Task Set', {
    dataType: 'SINGLE_SELECT',
    singleSelectOptions: Object.values(backlog.sets).map((name, i) => ({ name, color: colors[i % colors.length], description: '' })),
  });
  fields = await getFields();

  const spField = field('Story Points');
  const sprintField = field('Sprint');
  const setField = field('Task Set');
  const iterations = [
    ...(sprintField.configuration.iterations || []),
    ...(sprintField.configuration.completedIterations || []),
  ];
  const iterationId = (title) => iterations.find((it) => it.title === title)?.id;
  const optionId = (name) => setField.options.find((o) => o.name === name)?.id;

  const setValue = async (itemId, fieldId, value) =>
    gql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){ projectV2Item{ id } } }`,
      { p: project.id, i: itemId, f: fieldId, v: value },
    );

  const addItem = async (issue) =>
    (await gql(
      `mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }`,
      { p: project.id, c: issue.node_id },
    )).addProjectV2ItemById.item.id;

  for (const e of backlog.epics) await addItem(byBacklogId.get(e.id));
  for (const s of backlog.stories) {
    const itemId = await addItem(byBacklogId.get(s.id));
    await setValue(itemId, spField.id, { number: s.points });
    const it = iterationId(sprints[s.sprint].title);
    if (it) await setValue(itemId, sprintField.id, { iterationId: it });
    else core.warning(`Sprint iteration "${sprints[s.sprint].title}" not found on the project`);
    const opt = optionId(backlog.sets[s.set]);
    if (opt) await setValue(itemId, setField.id, { singleSelectOptionId: opt });
  }
  log(`project board synced (${backlog.epics.length} epics, ${backlog.stories.length} stories)`);
};
