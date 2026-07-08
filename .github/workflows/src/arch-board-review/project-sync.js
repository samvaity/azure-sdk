/**
 * Project Board Sync — adds arch board review issues to the GitHub Project
 * board and keeps the board Status column in sync with the issue's labels and
 * state.
 *
 * Because GitHub's built-in project auto-add and status-mapping workflows are
 * UI-only, this Action-based workflow implements them in a version-controlled,
 * reproducible way that works on both a personal fork and the upstream org.
 *
 * Configuration comes from environment variables so the same script works for
 * a user project (fork testing) and an organization project (upstream):
 *   - PROJECT_OWNER: login that owns the project (e.g. "samvaity" or "Azure")
 *   - PROJECT_NUMBER: the project number (e.g. "3")
 *   - PROJECT_SCOPE: "user" or "organization" (defaults to "user")
 *
 * Requires a token with the `project` scope (the default GITHUB_TOKEN cannot
 * write to user/org projects), provided via the PROJECT_TOKEN secret.
 */

import { LANGUAGE_DEFINITIONS } from "./issue-parsing.js";

const STATUS_FIELD_NAME = "Status";
const APPROVAL_LABEL_PATTERN = /-api-approved$/;

/**
 * Resolves the target board Status option name from the issue's labels/state.
 *
 * Purely label-driven, faithful to ARCH-BOARD-REVIEW-PROCESS.md:
 *   - closed OR all selected languages approved   -> Approved
 *   - some but not all <lang>-api-approved         -> In Review
 *   - ready-for-review (no approvals yet)          -> Ready for Review
 *   - needs-info                                   -> Changes Requested
 *   - otherwise (new, pre-triage)                  -> Incoming
 *
 * "All approved" is checked independently of the closed state because the
 * auto-close in approval-close.yml runs under the default GITHUB_TOKEN, and
 * GitHub does not fire workflow-triggering events for GITHUB_TOKEN actions.
 * Relying only on the `closed` event would leave the card stuck at In Review.
 *
 * Note: assignees are intentionally NOT used; the documented process is driven
 * entirely by labels applied by the triage bot and architects.
 */
function resolveStatus(issue) {
  const labels = (issue.labels || []).map((label) =>
    typeof label === "string" ? label : label.name,
  );

  const selectedLanguages = LANGUAGE_DEFINITIONS.filter((language) =>
    labels.includes(language.label),
  );
  const allLanguagesApproved =
    selectedLanguages.length > 0 &&
    selectedLanguages.every((language) => labels.includes(`${language.id}-api-approved`));

  if (issue.state === "closed" || allLanguagesApproved) {
    return "Approved";
  }
  if (labels.some((label) => APPROVAL_LABEL_PATTERN.test(label ?? ""))) {
    return "In Review";
  }
  if (labels.includes("needs-info")) {
    return "Changes Requested";
  }
  if (labels.includes("ready-for-review")) {
    return "Ready for Review";
  }
  return "Incoming";
}

async function fetchProject(github, { owner, number, scope }) {
  const ownerField = scope === "organization" ? "organization" : "user";
  const query = `
    query($owner: String!, $number: Int!) {
      ${ownerField}(login: $owner) {
        projectV2(number: $number) {
          id
          field(name: "${STATUS_FIELD_NAME}") {
            ... on ProjectV2SingleSelectField {
              id
              options { id name }
            }
          }
        }
      }
    }`;

  const data = await github.graphql(query, { owner, number });
  const project = data?.[ownerField]?.projectV2;
  if (!project) {
    throw new Error(`Project #${number} not found for ${scope} "${owner}".`);
  }
  return project;
}

async function addIssueToProject(github, { projectId, contentId }) {
  const mutation = `
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`;
  const data = await github.graphql(mutation, { projectId, contentId });
  return data.addProjectV2ItemById.item.id;
}

async function setItemStatus(github, { projectId, itemId, fieldId, optionId }) {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`;
  await github.graphql(mutation, { projectId, itemId, fieldId, optionId });
}

export default async function syncProject({ github, context, core }) {
  const owner = process.env.PROJECT_OWNER;
  const number = Number(process.env.PROJECT_NUMBER);
  const scope = process.env.PROJECT_SCOPE || "user";

  if (!owner || !Number.isInteger(number)) {
    core.setFailed("PROJECT_OWNER and PROJECT_NUMBER environment variables are required.");
    return;
  }

  const issue = context.payload.issue;
  if (!issue) {
    core.info("No issue in payload; nothing to sync.");
    return;
  }

  const project = await fetchProject(github, { owner, number, scope });
  const statusField = project.field;
  if (!statusField) {
    core.setFailed(`Project has no "${STATUS_FIELD_NAME}" single-select field.`);
    return;
  }

  const targetStatus = resolveStatus(issue);
  const option = statusField.options.find((opt) => opt.name === targetStatus);
  if (!option) {
    core.setFailed(
      `Status option "${targetStatus}" not found on the project. ` +
        `Available: ${statusField.options.map((o) => o.name).join(", ")}`,
    );
    return;
  }

  const itemId = await addIssueToProject(github, {
    projectId: project.id,
    contentId: issue.node_id,
  });

  await setItemStatus(github, {
    projectId: project.id,
    itemId,
    fieldId: statusField.id,
    optionId: option.id,
  });

  core.info(
    `Issue #${issue.number} synced to project ${owner}#${number} ` +
      `with Status "${targetStatus}".`,
  );
}
