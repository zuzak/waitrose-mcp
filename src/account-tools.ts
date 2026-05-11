import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import type {
  ShoppingContext,
  AccountProfile,
  Membership,
  Campaign,
} from "./waitrose.js";

export type AccountToolName =
  | "get_shopping_context"
  | "get_account_info"
  | "get_campaigns";

const ACCOUNT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_shopping_context",
  "get_account_info",
  "get_campaigns",
]);

export function isAccountTool(name: string): name is AccountToolName {
  return ACCOUNT_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

export type AccountInfoResponse = {
  profile: AccountProfile;
  memberships: Membership[] | null;
};

export type AccountToolResponse = ShoppingContext | AccountInfoResponse | Campaign[];

export async function dispatchAccountTool(
  client: WaitroseClient,
  toolName: AccountToolName,
  _args: Record<string, unknown>,
): Promise<AccountToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_shopping_context":
      return client.getShoppingContext();

    case "get_account_info":
      return client.getAccountInfo();

    case "get_campaigns":
      return client.getCampaigns();
  }
}
