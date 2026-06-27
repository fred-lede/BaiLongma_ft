// UI 类工具 schema：hotspot_mode / worldcup_mode / open_doc_panel /
// person_card_mode / focus_banner
// （声明式 Scene 的 ui_set 在 schemas/scene.js）
export const uiSchemas = {
  worldcup_mode: {
    type: 'function',
    function: {
      name: 'worldcup_mode',
      description: 'Control the World Cup panel (live scores, schedule and group standings for the FIFA World Cup, data from zhibo8.cc in Beijing time). Open it when the user asks about World Cup matches, scores or schedule and a visual panel helps; close it when asked. status checks current state. While the panel is open, current match data is injected into your context automatically.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'toggle', 'status'], description: 'show/open opens the worldcup panel; hide/close closes it; toggle switches it; status only checks state.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  hotspot_mode: {
    type: 'function',
    function: {
      name: 'hotspot_mode',
      description: 'Control the hotspot panel. Use only when the user explicitly asks, when a demo/roleplay needs it, or when the current task truly needs a visual hotspot scene. Do not proactively open it for ordinary Q&A. status checks current state.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'toggle', 'status'], description: 'show/open opens the hotspot panel; hide/close closes it; toggle switches it; status only checks state.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  open_doc_panel: {
    type: 'function',
    function: {
      name: 'open_doc_panel',
      description: 'Control the configuration documentation panel. Open it when the user needs voice, model, WeChat, or social-platform configuration help, or explicitly asks to open documentation. Close it when it is open but the conversation is unrelated to any configuration topic. Panel contents are injected as context for 30 minutes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'close'],
            description: 'open opens the panel; close closes the panel.'
          },
          topic: {
            type: 'string',
            enum: ['voice_asr', 'voice_tts', 'voice_config', 'model_config', 'wechat_config', 'self_architecture', 'ui_design'],
            description: 'Required when action=open. Choose one topic: voice_asr, voice_tts, voice_config, model_config, wechat_config, self_architecture (how BaiLongma works internally), or ui_design (BaiLongma\'s interface / Scene UI design). Do not invent other values. Optional when action=close.'
          },
          reason: { type: 'string', description: 'Optional short reason.' },
        },
        required: ['action']
      }
    }
  },

  person_card_mode: {
    type: 'function',
    function: {
      name: 'person_card_mode',
      description: 'Control the person-card panel. Use only when the user says they do not know someone, asks who someone is or why they are popular, or when the current conversation truly needs a public-figure explanation. Do not proactively open it for ordinary Q&A. Basic profile data can update the card.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'], description: 'show/open/update opens or updates the person card; hide/close closes it; toggle switches it; status only checks state.' },
          name: { type: 'string', description: 'Person name, e.g. Jay Chou.' },
          title: { type: 'string', description: 'Identity or title, e.g. singer / musician.' },
          summary: { type: 'string', description: 'One or two sentence summary. Avoid inventing uncertain information.' },
          knownFor: { type: 'array', items: { type: 'string' }, description: 'Representative works, events, or recognition points the user most needs.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Short tags, e.g. actor or Mandopop.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Aliases, English names, or common nicknames.' },
          image: { type: 'string', description: 'Optional large image URL, preferred for the card hero image.' },
          avatar: { type: 'string', description: 'Optional avatar or person image URL.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  focus_banner: {
    type: 'function',
    function: {
      name: 'focus_banner',
      description: 'Show a translucent desktop focus banner sticker reminding the user what to focus on. Call when the user says they want to focus on something, enter focus mode, or asks for help focusing on X. The banner can expand to show a task list with checkboxes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['show', 'update', 'hide'],
            description: 'show displays the banner; update changes content when it already exists; hide closes it.'
          },
          task: {
            type: 'string',
            description: 'Main task title, one short sentence.'
          },
          current_step: {
            type: 'string',
            description: 'Optional current step, shown under the main task when collapsed.'
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Subtask text.' },
                done: { type: 'boolean', description: 'Whether completed, default false.' }
              },
              required: ['text']
            },
            description: 'Optional subtask list shown when the banner is expanded.'
          }
        },
        required: ['action']
      }
    }
  },

  voice_retire: {
    type: 'function',
    function: {
      name: 'voice_retire',
      description: 'Gracefully collapse the floating voice orb — the listening ball shown on screen during a voice conversation. Call it when, in a voice conversation, the user asks you to leave / stop / says that is all (退下 / 没事了 / 再见 / 先这样), OR the task is fully complete and no follow-up is expected. It retires only the on-screen ball after you finish speaking; it does NOT end the app or stop you from being reachable. No-op if no orb is currently showing.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional short reason, e.g. user said goodbye / task done.' },
        },
        required: []
      }
    }
  },
}
