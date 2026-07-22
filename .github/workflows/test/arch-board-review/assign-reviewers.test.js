import { describe, expect, it, vi } from "vitest";

import assignReviewers, {
  pickReviewer,
  resolveAssignments,
} from "../../src/arch-board-review/assign-reviewers.js";

const approversConfig = {
  "data-plane": {
    java: ["JonathanGiles", "alzimmermsft"],
    python: ["xirzec", "kashifkhan"],
  },
  "management-plane": {
    all: ["ArthurMa1978", "m-nash"],
  },
};

function createGithubMock() {
  return {
    rest: {
      issues: {
        addAssignees: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

function createContext({ issueBody, number = 456, assignees = [] }) {
  return {
    repo: { owner: "Azure", repo: "azure-sdk" },
    payload: {
      issue: {
        number,
        body: issueBody,
        assignees: assignees.map((login) => ({ login })),
      },
    },
  };
}

describe("pickReviewer", () => {
  it("returns null for an empty candidate list", () => {
    expect(pickReviewer([], 5)).toBeNull();
    expect(pickReviewer(undefined, 5)).toBeNull();
  });

  it("distributes deterministically by issue number", () => {
    const candidates = ["a", "b"];
    expect(pickReviewer(candidates, 4)).toBe("a");
    expect(pickReviewer(candidates, 5)).toBe("b");
  });
});

describe("resolveAssignments", () => {
  it("resolves one reviewer per selected language", () => {
    const issueBody = "- [x] Java\n- [x] Python";
    const { byLanguage, assignees } = resolveAssignments({
      issueBody,
      issueNumber: 456,
      approversConfig,
    });
    expect(byLanguage).toEqual([
      { language: "Java", reviewer: "JonathanGiles" },
      { language: "Python", reviewer: "xirzec" },
    ]);
    expect(assignees).toEqual(["JonathanGiles", "xirzec"]);
  });

  it("adds management-plane approvers for management-plane issues", () => {
    const issueBody = "This is a management plane library.\n- [x] Java";
    const { assignees } = resolveAssignments({
      issueBody,
      issueNumber: 1,
      approversConfig,
    });
    expect(assignees.length).toBeGreaterThan(0);
  });

  it("returns nothing when no languages are selected", () => {
    const { byLanguage, assignees } = resolveAssignments({
      issueBody: "no languages here",
      issueNumber: 1,
      approversConfig,
    });
    expect(byLanguage).toEqual([]);
    expect(assignees).toEqual([]);
  });
});

describe("assignReviewers", () => {
  const core = { info: vi.fn() };

  it("assigns resolved reviewers and returns the per-language mapping", async () => {
    const github = createGithubMock();
    const context = createContext({ issueBody: "- [x] Java" });

    const result = await assignReviewers({ github, context, core, approversConfig });

    expect(result.assigned).toEqual(["JonathanGiles"]);
    expect(result.byLanguage).toEqual([{ language: "Java", reviewer: "JonathanGiles" }]);
    expect(github.rest.issues.addAssignees).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ["JonathanGiles"] }),
    );
  });

  it("does not post a comment (comment is owned by triage)", async () => {
    const github = createGithubMock();
    const context = createContext({ issueBody: "- [x] Java" });

    await assignReviewers({ github, context, core, approversConfig });

    expect(github.rest.issues.createComment).toBeUndefined();
  });

  it("is idempotent when the reviewer is already assigned", async () => {
    const github = createGithubMock();
    const context = createContext({
      issueBody: "- [x] Java",
      assignees: ["jonathangiles"],
    });

    const result = await assignReviewers({ github, context, core, approversConfig });

    expect(result.skipped).toBe(true);
    expect(github.rest.issues.addAssignees).not.toHaveBeenCalled();
  });
});
