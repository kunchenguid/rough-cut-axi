export const PROJECT_SCHEMA = {
  version: 1,
  properties: {
    version: { type: "number" },
    title: { type: "string" },
    footages: { type: "array" },
    timeline: { type: "array" },
    chat: { type: "object" },
    render: { type: "object" },
    operationLog: { type: "array" },
  },
  required: ["version", "title", "footages", "timeline", "chat", "render", "operationLog"],
};

export function createInitialProject({ title, footages }) {
  return {
    version: PROJECT_SCHEMA.version,
    title,
    footages,
    timeline: footages.map((footage) => footage.id),
    chat: {
      pendingPrompts: [],
      messages: [],
      agentPresence: "waiting",
    },
    render: {
      finalPath: "renders/final.mov",
    },
    operationLog: [],
  };
}

export function validateProject(project) {
  const errors = [];

  for (const key of PROJECT_SCHEMA.required) {
    if (!Object.hasOwn(project, key)) {
      errors.push(`${key} is required`);
    }
  }

  return errors;
}
