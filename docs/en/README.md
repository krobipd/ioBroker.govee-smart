# Govee Smart

Controls Govee Wi-Fi devices from ioBroker: light strips, bulbs and panels, thermometers and
hygrometers, and appliances such as heaters, humidifiers, kettles, ice makers, fans and air
purifiers.

The adapter talks to your devices **locally whenever it can**. A light with the local API enabled
answers on your own network in milliseconds, and the cloud is never allowed to overwrite what the
device just said locally. The cloud fills in what only it knows — device names, capabilities,
scenes and snapshots — and takes over control for devices that have no local API at all.

## What you get for what you enter

Everything is optional except the first line. Enter more and more becomes available; enter nothing
and local control still works.

| What you enter | What the adapter can do |
| --- | --- |
| Nothing | Find lights on your network and switch them: power, brightness, colour, colour temperature, status |
| + Govee API key | Device names, capabilities, scenes, snapshots and segments |
| + Govee account (e-mail and password) | Real-time status updates pushed from Govee, so changes made in the app or on the device show up at once |

The API key is free and comes from the Govee Home app. The account login is what the app itself
uses; the adapter only listens on it and never sends commands through it.

**The local API has to be switched on per device, in the Govee Home app** (device settings → LAN
Control). Without it, that device is controlled through the cloud — which works, but takes a few
seconds per command and is rate-limited by Govee.

## Setting it up

1. Install the adapter and create an instance.
2. Open the instance settings. The **Connection** card walks you through the three tiers above and
   tells you what is working and what is not — including a login test that really logs in rather
   than just checking the form.
3. If Govee asks for a verification code (it does that for a new client), the card asks you for it.
   Nothing else is needed; the adapter remembers the login across restarts so no further codes are
   sent.
4. Devices appear under `devices.<model>_<id>`. Groups you created in the Govee app appear under
   `groups.`.

## Reporting a problem

Every device has an **Export diagnostics** button under its `diag` channel. Press it and the
adapter writes a report file. Download it in the adapter's **Diagnostics** tab and attach it to a
GitHub issue — the issue forms ask for exactly this file.

The report is **pseudonymised**: IP addresses, mail addresses and device names are replaced by
stable markers, device ids are shortened, and credentials never appear at all. The same real value
always maps to the same marker inside one file, so the report stays followable without carrying
anything about your home. The file explains all of this in its own header.

A report is what lets a device be added or a bug found without anyone needing your hardware. If it
does not contain enough to do that, the report is at fault, not you — please say so in the issue.

## Where to read more

The wiki has the detail, in English and German:

- **Setup** — the three tiers, the local API, verification codes, what to do when a channel stays off
- **Behavior** — which channel handles what, how reachability is decided, what happens when the cloud is down
- **State tree** — every datapoint, what writes it and what you may write yourself
- **Scenes and snapshots** — scenes, DIY scenes, cloud snapshots and locally saved snapshots
- **Segments** — segment control, the detection wizard, cut strips and manual segment lists
- **Groups** — how Govee app groups behave here
- **Sensors and appliances** — readings, events and what the cloud limits mean
- **Devices** — every supported model, generated from the adapter's own catalogue

→ <https://github.com/krobipd/ioBroker.govee-smart/wiki>

## Device not listed?

Send a diagnostics report and the model gets added. That is what the report exists for — the
catalogue grows from user reports, and no hardware needs to change hands.
