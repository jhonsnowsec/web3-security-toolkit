import { ContractWithEventsBase, EventArgsForName, EventNamesFor } from "../../../lib/utils/events/truffle";
import { EvmEvent } from "../../../lib/utils/events/common";
import { AnyFunction, multimapAdd, multimapDelete } from "../../../lib/utils/helpers";
import { ClearableSubscription, EventEmitter, EventExecutionQueue } from "../../../lib/utils/events/ScopedEvents";
import { TransactionInterceptor } from "./TransactionInterceptor";
import { EvmEventArgsForName, IEvmEvents } from "../../../lib/utils/events/IEvmEvents";

interface FilteredHandler {
    filter: Record<string, unknown> | undefined;
    handler: AnyFunction<void>;
}

export class InterceptorEvmEvents implements IEvmEvents {
    constructor(
        public interceptor: TransactionInterceptor,
        public eventQueue: EventExecutionQueue | null,
    ) {
        interceptor.eventHandlers.set('EvmEventsDispatcher', this.handleEvent.bind(this));
    }

    // map 'address:eventName' => filtered handlers
    private handlers = new Map<string, Set<FilteredHandler>>();

    private handleEvent(event: EvmEvent) {
        const key = `${event.address}:${event.event}`;
        const handlers = this.handlers.get(key);
        if (handlers == null)
            return;
        const args = { ...event.args, $event: event };
        for (const handler of handlers) {
            if (handler.filter == null || this.filterMatches(handler.filter, event.args)) {
                handler.handler(args);
            }
        }
    }

    private filterMatches(filter: Record<string, unknown>, args: Record<string, unknown>) {
        return Object.entries(filter).every(([key, value]) => String(value) === String(args[key]));
    }

    public event<C extends ContractWithEventsBase, N extends EventNamesFor<C>>(contract: C, event: N, filter?: Partial<EventArgsForName<C, N>>) {
        return new EventEmitter<EvmEventArgsForName<C, N>>(this.eventQueue, handler => {
            const key = `${contract.address}:${event}`;
            const filteredHandler: FilteredHandler = { filter, handler };
            multimapAdd(this.handlers, key, filteredHandler);
            return ClearableSubscription.of(() => multimapDelete(this.handlers, key, filteredHandler));
        });
    }
}
