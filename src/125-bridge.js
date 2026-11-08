/**
 * Bridge to the Harness client services.
 *
 * The plugin's own data lives behind the Host route, but the model the CURRENT
 * session runs on lives in the Session's `modelSelection` projection, which
 * only the browser half can read: the Host only knows the deployment default.
 * The panel registration installs the client context here, so the settings page
 * can name the model the conversation is actually using instead of saying
 * "the same as the session".
 */

/** The client context, installed once by the panel registration. */
let CLIENT_CTX = null;

/** Remember the client context. */
function setClientContext(ctx) {
  CLIENT_CTX = ctx;
}

/** The client Session service, or null when the shell has none yet. */
function clientSessions() {
  try {
    return CLIENT_CTX?.get?.('sessions') ?? null;
  } catch {
    return null;
  }
}

/** The Session the shell is currently showing, or null. */
function currentSessionId() {
  const sessions = clientSessions();
  if (!sessions) return null;
  try {
    const byId = sessions.list.getSnapshot().byId;
    return Object.values(byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The model the current session is using.
 * @returns {{provider: string, model: string}|null} the live selection.
 */
function readSessionModel() {
  const sessions = clientSessions();
  const id = currentSessionId();
  if (!sessions || !id) return null;
  try {
    const view = sessions.binding(id)?.session?.projections?.faceOf('modelSelection')?.getSnapshot();
    const selection = view?.next ?? view?.lastUsed;
    return selection?.provider ? { provider: selection.provider, model: selection.model } : null;
  } catch {
    return null;
  }
}

/**
 * Watch the current session's model selection.
 *
 * The projection face exists only once the session is bound, so the listener
 * re-reads the binding on every notification: a session that binds later still
 * reports its model.
 * @param {Function} listener called on every change.
 * @returns {Function} unsubscribe.
 */
function subscribeSessionModel(listener) {
  const sessions = clientSessions();
  const disposers = [];
  const update = () => {
    try {
      listener(readSessionModel());
    } catch {
      /* a stale binding must not break the page */
    }
  };
  try {
    if (sessions?.list?.subscribe) disposers.push(sessions.list.subscribe(update));
    const id = currentSessionId();
    const face = sessions?.binding?.(id)?.session?.projections?.faceOf('modelSelection');
    if (face?.subscribe) disposers.push(face.subscribe(update));
  } catch {
    /* no session yet */
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * The current session's model, kept live.
 * @returns {{provider: string, model: string}|null} selection.
 */
function useSessionModel() {
  const [model, setModel] = React.useState(null);
  React.useEffect(() => {
    setModel(readSessionModel());
    return subscribeSessionModel(setModel);
  }, []);
  return model;
}

/**
 * The Harness model catalog: providers with their display names and models.
 *
 * This is the same grouped roster the Harness model picker renders, so the
 * settings page names providers and models exactly like the shell does. The
 * Host route cannot supply it: only the browser half holds the model catalog
 * the picker reads.
 *
 * @returns {Promise<{groups: object[], default: object|null}|null>} catalog.
 */
async function readModelCatalog() {
  try {
    const remote = CLIENT_CTX?.get?.('remote');
    const session = remote?.session;
    if (!session || typeof session.modelCatalog !== 'function') return null;
    const response = await session.modelCatalog();
    if (!response || response.ok !== true || !response.value) return null;
    return response.value;
  } catch {
    return null;
  }
}

/**
 * The model catalog, kept live.
 * @returns {{groups: object[], default: object|null}|null} catalog.
 */
function useModelCatalog() {
  const [catalog, setCatalog] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    readModelCatalog().then((value) => {
      if (alive) setCatalog(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return catalog;
}
