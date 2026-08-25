import type { PluginDescriptor } from "emdash";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

const EMAIL_RE = /^.+@.+\..+$/;

type SettingsInteraction =
	| { type: "page_load"; page: string }
	| {
			type: "form_submit";
			action_id: string;
			values?: Record<string, unknown>;
	  };

function isValidEmail(value: string): boolean {
	return EMAIL_RE.test(value);
}

async function sendViaResend(
	ctx: PluginContext,
	apiKey: string,
	payload: Record<string, unknown>,
) {
	if (!ctx.http) throw new Error("缺少 network:request 权限");

	const response = await ctx.http.fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Resend API 返回 ${response.status}: ${await response.text()}`);
	}
}

async function buildSettingsPage(ctx: PluginContext) {
	const hasKey = !!(await ctx.kv.get("settings:apiKey"));
	const fromAddress = (await ctx.kv.get("settings:fromAddress")) ?? "";

	return {
		blocks: [
			{
				type: "section",
				text: "配置 Resend API 凭据以启用网站邮件发送。",
			},
			{
				type: "form",
				submit: { label: "保存设置", action_id: "save_settings" },
				fields: [
					{
						type: "secret_input",
						action_id: "apiKey",
						label: "Resend API Key",
						placeholder: "re_...",
						has_value: hasKey,
						required: true,
					},
					{
						type: "text_input",
						action_id: "fromAddress",
						label: "发件人地址",
						placeholder: "My Notes <hello@example.com>",
						initial_value: fromAddress,
						required: true,
					},
				],
			},
			{
				type: "section",
				text: "发送测试邮件，验证 API Key 和发件人地址。",
			},
			{
				type: "form",
				submit: { label: "发送测试邮件", action_id: "test_email" },
				fields: [
					{
						type: "text_input",
						action_id: "testEmailAddress",
						label: "收件人地址",
						placeholder: "you@example.com",
						initial_value: "",
					},
				],
			},
		],
	};
}

const resendProvider = {
	hooks: {
		"email:deliver": {
			exclusive: true,
			handler: async (event, ctx) => {
				const apiKey = await ctx.kv.get("settings:apiKey");
				const fromAddress = await ctx.kv.get("settings:fromAddress");
				if (typeof apiKey !== "string" || typeof fromAddress !== "string") {
					throw new Error("请先在 Resend 插件设置中配置 API Key 和发件人地址");
				}

				await sendViaResend(ctx, apiKey, {
					from: fromAddress,
					to: event.message.to,
					subject: event.message.subject,
					text: event.message.text,
					html: event.message.html,
				});
			},
		},
	},
	routes: {
		admin: async (routeCtx, ctx) => {
			const interaction = routeCtx.input as SettingsInteraction;
			if (interaction.type === "page_load" && interaction.page === "/settings") {
				return buildSettingsPage(ctx);
			}

			if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
				const apiKey = interaction.values?.apiKey;
				const fromAddress = interaction.values?.fromAddress;
				if (typeof apiKey === "string" && apiKey && apiKey !== "********") {
					await ctx.kv.set("settings:apiKey", apiKey);
				}
				if (typeof fromAddress !== "string" || !isValidEmail(fromAddress)) {
					return {
						...(await buildSettingsPage(ctx)),
						toast: { message: "发件人地址无效", type: "error" },
					};
				}
				await ctx.kv.set("settings:fromAddress", fromAddress);
				return {
					...(await buildSettingsPage(ctx)),
					toast: { message: "设置已保存", type: "success" },
				};
			}

			if (interaction.type === "form_submit" && interaction.action_id === "test_email") {
				try {
					const apiKey = await ctx.kv.get("settings:apiKey");
					const fromAddress = await ctx.kv.get("settings:fromAddress");
					const recipient = interaction.values?.testEmailAddress;
					if (typeof apiKey !== "string" || typeof fromAddress !== "string") {
						throw new Error("请先保存 API Key 和发件人地址");
					}
					if (typeof recipient !== "string" || !isValidEmail(recipient)) {
						throw new Error("请输入有效的收件人地址");
					}
					await sendViaResend(ctx, apiKey, {
						from: fromAddress,
						to: recipient,
						subject: "My Notes 测试邮件",
						text: "Resend 邮件提供商已配置成功。",
					});
					return {
						...(await buildSettingsPage(ctx)),
						toast: { message: "测试邮件已发送", type: "success" },
					};
				} catch (error) {
					return {
						...(await buildSettingsPage(ctx)),
						toast: {
							message: error instanceof Error ? error.message : "测试邮件发送失败",
							type: "error",
						},
					};
				}
			}

			return { blocks: [] };
		},
	},
} satisfies SandboxedPlugin;

export default resendProvider;

export function resendPlugin(): PluginDescriptor {
	return {
		id: "emdash-resend",
		version: "1.0.0",
		entrypoint: "mynotes/resend-provider",
		format: "standard",
		capabilities: ["hooks.email-transport:register", "network:request"],
		allowedHosts: ["api.resend.com"],
		adminPages: [{ path: "/settings", label: "Resend", icon: "email" }],
	};
}
