import { describe, expect, it } from "vite-plus/test";

import { mobileClientUpdatedAtLabel } from "./MobileClientsUserProfilePage.logic";

describe("mobile client clock preference", () => {
  it("labels the update time with its date in the chosen clock format", () => {
    const updatedAt = new Date(2025, 3, 7, 15, 44, 9).toISOString();
    const label = mobileClientUpdatedAtLabel(updatedAt, "24-hour");
    expect(label).toMatch(/^Updated .*2025.*15:44$/);
    expect(mobileClientUpdatedAtLabel(updatedAt, "12-hour")).toMatch(/3:44\s[ap]m$/i);
  });
});
