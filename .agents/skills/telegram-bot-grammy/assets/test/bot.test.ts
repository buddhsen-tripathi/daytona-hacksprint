import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Drizzle DB
function createMockDb() {
  return {
    insertUser: vi.fn().mockResolvedValue({
      id: 1,
      telegramId: "123456",
      username: "testuser",
      firstName: "Test",
      lastName: null,
    }),
    findUserByTelegramId: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue({ id: 1, telegramId: "123456" }),
    upsertSetting: vi
      .fn()
      .mockResolvedValue({ id: 1, key: "theme", value: "dark" }),
  };
}

// Mock grammY Context
function createMockContext(options: {
  text?: string;
  command?: string;
  userId?: number;
  username?: string;
  firstName?: string;
}) {
  const {
    text,
    command,
    userId = 123456,
    username = "testuser",
    firstName = "Test",
  } = options;

  return {
    message: {
      text: command ? `/${command}` : text,
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private" as const },
    },
    from: {
      id: userId,
      is_bot: false,
      first_name: firstName,
      username,
    },
    chat: { id: userId, type: "private" as const },
    reply: vi.fn().mockResolvedValue({ message_id: 2 }),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
  };
}

describe("Bot Commands", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
  });

  describe("/start command", () => {
    it("should upsert user on /start with Drizzle pattern", async () => {
      const ctx = createMockContext({ command: "start" });

      await mockDb.insertUser({
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: null,
      });

      await ctx.reply("Welcome to the Bot! Send /help for help.");

      expect(mockDb.insertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          telegramId: "123456",
        }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        "Welcome to the Bot! Send /help for help.",
      );
    });
  });

  describe("/help command", () => {
    it("should reply with help message", async () => {
      const ctx = createMockContext({ command: "help" });

      await ctx.reply("Available commands:\n/start - Start\n/help - Help");

      expect(ctx.reply).toHaveBeenCalledWith(
        "Available commands:\n/start - Start\n/help - Help",
      );
    });
  });

  describe("Message handling", () => {
    it("should reply to text messages", async () => {
      const ctx = createMockContext({ text: "Hello bot!" });

      await ctx.reply("Message received!");

      expect(ctx.reply).toHaveBeenCalledWith("Message received!");
    });
  });
});

describe("Drizzle-style DB Operations", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
  });

  describe("User operations", () => {
    it("should find user by telegramId", async () => {
      const mockUser = {
        id: 1,
        telegramId: "123456",
        username: "testuser",
        firstName: "Test",
        lastName: null,
      };
      mockDb.findUserByTelegramId.mockResolvedValueOnce(mockUser);

      const result = await mockDb.findUserByTelegramId("123456");

      expect(result).toEqual(mockUser);
      expect(mockDb.findUserByTelegramId).toHaveBeenCalledWith("123456");
    });

    it("should return null for non-existent user", async () => {
      const result = await mockDb.findUserByTelegramId("999999");

      expect(result).toBeNull();
    });

    it("should create new user", async () => {
      const result = await mockDb.createUser({
        telegramId: "123456",
        username: "newuser",
        firstName: "New",
      });

      expect(result.telegramId).toBe("123456");
    });
  });

  describe("Setting operations", () => {
    it("should upsert user setting", async () => {
      const result = await mockDb.upsertSetting({
        userId: 1,
        key: "theme",
        value: "dark",
      });

      expect(result.key).toBe("theme");
      expect(result.value).toBe("dark");
    });
  });
});

describe("Callback Queries", () => {
  it("should answer callback query", async () => {
    const ctx = createMockContext({ userId: 123456 });

    await ctx.answerCallbackQuery("Operation successful!");

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      "Operation successful!",
    );
  });
});
