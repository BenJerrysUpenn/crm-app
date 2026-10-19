# Withers Ventures operations

The CRM and Withers Time share one database and one language: catering deals, the staff who work them, and what staff are paid for that work.

## Staff pay

**Travel Reimbursement**:
One request from a staff member to be paid back for travel on one Reason: mileage, tolls and parking, with any Receipts. Paid through payroll, untaxed.
_Avoid_: Claim, expense, expense report, mileage claim

**Reason**:
What a Travel Reimbursement was for: either Groceries / errands, or one specific Catering Event.
_Avoid_: Purpose, category

**Catering Event**:
One booked catering deal as staff recognise it: date, start time, venue or company, and address. Several can fall on the same day.
_Avoid_: Deal (in staff-facing language), job, gig

**Mileage**:
Miles driven in a staff member's own car for a Reason, either typed by them or computed from the stops they enter.

**Mileage rate**:
The IRS business standard mileage rate in effect on the trip date.
_Avoid_: House rate

**Adjustment**:
An Approver's change to an amount on a Travel Reimbursement, backed by evidence such as a screenshot of the conversation that settled it.
_Avoid_: Correction, override

**Lyft ride report**:
A screenshot of a Lyft ride booked on the company card, uploaded against a Reason as the record of that ride. Nothing is paid back for it.
_Avoid_: Lyft receipt, Uber

**Receipt**:
Proof of a toll, parking charge or ride, uploaded with a Travel Reimbursement when one exists.

**Approver**:
A manager or owner deciding a Travel Reimbursement. Owners may decide their own.

**Submitted / Approved / Rejected / Paid**:
The life of a Travel Reimbursement: waiting for an Approver, accepted for the next payroll, sent back with a reason to fix, or included on a paycheck. An owner's approved reimbursement is instead **Paid outside payroll**.

**Filed**:
The only state of a Lyft ride report. It is recorded and sent to receipts@, with nothing to approve or pay.

**Claim** (a shift):
Picking up an open shift on the schedule. Reserved for shifts; never used for reimbursements.

## Labor planning

**Affordable hours**:
The hours a week's sales pay for: projected in-store sales plus concession event net sales, times the hourly goal in force each day, divided by the average hourly rate of active hourly staff. Projected in-store sales are last year's sales on the same weekday times the trend factor.
_Avoid_: Target hours (that is the whole bar), budget hours

**Coverage hours**:
The store's opening hours in a week under the store-hours season in force each day, for one person: the least the floor needs whatever sales are. Closed days count zero.
_Avoid_: Minimum staffing, floor hours

**Catering booked hours**:
For a week ahead, the hours of the Catering shifts on its booked deals; a booked deal with no shifts yet counts its billed crew hours (labor hours times staff count).
_Avoid_: Catering labor (ambiguous between booked and estimated)

**Catering estimated hours**:
For a week ahead, last year's Catering shift hours in the same week less the catering booked hours, never below zero, plus the crew hours of a dated crew event that week. Booking catering moves hours from estimated to booked.
_Avoid_: Forecast catering, catering pipeline

**Store-hours season**:
A period of opening hours with a first day (winter, summer). From that day its hours replace the weekly store hours until the next season starts; before the first season the weekly hours apply.
_Avoid_: Schedule, winter schedule

**Concession event**:
An event at an outside venue (a convention show) where the business sells: its days and its expected net sales, spread evenly over its days. Not catering, and not in the catering CRM.
_Avoid_: Catering event, popup

**Free Cone Day**:
The brand's yearly free-cone event: a dated crew event whose crew hours count in that week's catering estimated hours, and whose day is left out of last year's catering hours.
_Avoid_: Cone day promo
