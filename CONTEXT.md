# Gift Inventory

Tracks the stock of promotional gifts (bags, pens, toys, etc.) held by the team. Staff record stock on phones over the local Wi-Fi, and admins manage it from a web dashboard.

## Language

**Gift**:
A kind of promotional item the team keeps in stock, such as "Blue logo pen". It is a kind of item, not a single physical unit. A Gift belongs to one Category and is either Active or Archived. Archived Gifts keep their history but are hidden from new entries.
_Avoid_: Asset, product, item, SKU

**Category**:
A grouping of Gifts by type, such as "Bags", "Pens" or "Toys".
_Avoid_: Type, group, class

**Piece**:
One single physical unit of a Gift. All Stock Levels are stored and reported in Pieces.
_Avoid_: Unit, each, item

**Pack**:
A named multiple of Pieces defined for a Gift, such as "Carton = 50". It is only a shortcut for entering quantities and is converted to Pieces straight away.
_Avoid_: Box, case, bundle

**Low-Stock Threshold**:
The total number of Pieces of a Gift at or below which it is flagged as running low.
_Avoid_: Reorder point, minimum

**User**:
A person with their own login. Every Count and Movement records the User who made it. A User is either Staff or Admin.
_Avoid_: Account, member, operator

**Staff**:
A User who records Counts and Movements and creates Events. Staff can Void only their own entries, and only within 10 minutes of making them.

**Admin**:
A User who can do everything Staff can, and also manages Gifts, Locations, Events and Users and corrects past entries.
_Avoid_: Manager, superuser

**Device**:
A phone that has been paired with the server by scanning a pairing code from the Admin dashboard. An Admin can revoke a Device, for example when a phone is lost.
_Avoid_: Client, handset

**Gift Label**:
A QR code the system generates for one Gift, printed and stuck on the shelf or bin. It identifies the Gift only, not its Location.
_Avoid_: Tag, sticker

**Barcode**:
An existing code printed on a Gift's packaging by its maker, such as an EAN or UPC. A Gift can have any number of linked Barcodes.

**Location**:
A named place where Gifts are physically kept, such as "Storeroom" or "Event booth". Stock is held per Gift per Location.
_Avoid_: Warehouse, site, bin

**Stock Level**:
The quantity of one Gift at one Location. A Gift's total stock is the sum across all Locations. A Stock Level can be negative, which signals a discrepancy for an Admin to resolve.
_Avoid_: Balance, inventory

**Entry Mode**:
What a user records on the phone: **Count**, **Receive**, **Issue**, **Transfer** or **Write-off**. It is Receive unless the user changes it in Settings, and the phone remembers the last choice.

**Count**:
An entry that states the absolute quantity of a Gift someone physically counted at one Location, such as "there are 42 in the Storeroom". It replaces that Stock Level.
_Avoid_: Stocktake, inventory check

**Movement**:
An entry that states a change in the quantity of a Gift, such as "+100 arrived" or "−15 given out". Every Movement is exactly one of Receive, Issue, Transfer or Write-off.
_Avoid_: Transaction, adjustment

**Receive**:
A Movement that adds new stock of a Gift at one Location, such as a supplier delivery.

**Issue**:
A Movement that removes stock of a Gift at one Location because it was given out at an Event.
_Avoid_: Give-away, distribution, checkout

**Transfer**:
A Movement that moves stock of a Gift from one Location to another. The Gift's total stock is unchanged.

**Write-off**:
A Movement that removes stock of a Gift at one Location because it was lost, damaged or otherwise unusable.
_Avoid_: Loss, shrinkage

**Void**:
Marking a past Count or Movement as cancelled, with who did it, when and why. A Voided entry stays visible in history but no longer affects Stock Levels. Entries are never edited or deleted, only Voided and re-entered.
_Avoid_: Delete, undo, reverse, cancel

**Event**:
The occasion that an Issue gives Gifts out for, such as "Fall Career Fair 2026". It has a date range and is either Open or Closed. It closes automatically 3 days after its end date, and an Admin can close or reopen it at any time. Only an Open Event can be chosen for a new Issue, but an Issue recorded while the Event was Open still counts if it syncs after closing.
_Avoid_: Campaign, activity
