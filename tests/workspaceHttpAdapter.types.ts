import type { WorkspaceHttpApi } from '../server/src/workspaceHttp.js';
import { createWorkspaceHttpApi } from '../src/cloud/workspaceHttp.node';
import type { OwnedWorkspaceRuntime } from '../src/cloud/ownedWorkspaceRuntime.node';

declare const runtime: OwnedWorkspaceRuntime;
const httpApi: WorkspaceHttpApi = createWorkspaceHttpApi(runtime);
void httpApi;
