// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

// Deploy defaults target this repo's GitHub Pages project URL
// (https://danielscholl.github.io/keelson-rib-chat/). For a custom domain, set
// base to "/" and add a CNAME.
export default defineConfig({
  site: "https://danielscholl.github.io",
  base: "/keelson-rib-chat",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Keelson Rib · Chat",
      description:
        "Chat as a Keelson rib: read-only agent swarms that coordinate over a ClickClack channel a human can watch, steer, and stop.",
      favicon: "/assets/keelson-mark.svg",
      customCss: ["./src/styles/keelson-theme.css"],
      // Emits /llms.txt, /llms-full.txt, /llms-small.txt at build (llmstxt.org).
      plugins: [
        starlightLlmsTxt({
          projectName: "Keelson Rib · Chat",
          description:
            "A Keelson rib that runs agent swarms over ClickClack: each agent is a real chat bot, a dispatcher wakes an agent when it is addressed, agents read caller-supplied task context in place of a forge, and the whole swarm runs as one durable, steerable op.",
        }),
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/danielscholl/keelson-rib-chat",
        },
      ],
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        { label: "Design", items: [{ autogenerate: { directory: "design" } }] },
      ],
    }),
  ],
});
