import { EventEmitter } from "node:events";

/**
 * Evento de delegação PM → Dev. A delegação é uma AÇÃO OBSERVÁVEL: o PM cria o
 * ticket e dispara este evento; o worker do Dev reage. Tudo acontece na mesma
 * thread do Slack, então você vê o handoff acontecendo.
 *
 * MVP: barramento em processo (EventEmitter). Em escala, troca-se por BullMQ/Redis
 * ou Temporal sem mexer em quem publica/consome.
 */
export interface DevTaskRequested {
  channel: string;
  threadTs: string;
  threadKey: string;
  ticket: { identifier?: string; url?: string; title: string };
  instructions: string;
  repo?: string;
}

interface EventMap {
  "dev.task.requested": DevTaskRequested;
}

class TypedBus {
  private emitter = new EventEmitter();

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }
}

export const bus = new TypedBus();
