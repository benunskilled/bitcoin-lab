# Give new manual peers time to settle

A newly promoted peer gets a grace period of 50 blocks in its manual slot. During that time, rotation will not replace it with a stronger candidate.

The count starts at promotion. Without this fresh grace period, two closely ranked peers could repeatedly replace each other before either had time to establish its performance in the slot. That happened on my node: two peers traded the same place for hours.

The grace period prevents those unnecessary swaps. If the peer goes offline, the [parking rules](parking.md) determine how long its slot stays reserved.

The thresholds described here are defaults. See [Configuration](configuration.md) for the available settings.

---

[← Back to the README](../README.md)
