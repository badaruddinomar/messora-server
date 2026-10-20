import { ChargeType, MemberStatus, MonthStatus, Prisma } from "@prisma/client";
import { audit } from "../../lib/audit.js";
import { prisma, type DbClient } from "../../lib/prisma.js";
import type { Membership } from "../../middlewares/tenant.js";
import { ApiError } from "../../utils/api-error.js";
import { toDbDate } from "../../utils/date.js";
import { sumMoney } from "../../utils/money.js";
import type { RoomInput, SeatInput, UpdateSeatInput } from "./rooms.schema.js";
import { seatRent } from "./seat-rent.js";

const seatInclude = {
  member: { select: { id: true, user: { select: { name: true, avatarUrl: true } } } },
} satisfies Prisma.SeatInclude;

type SeatRow = Prisma.SeatGetPayload<{ include: typeof seatInclude }>;

const toSeatDto = (s: SeatRow) => ({
  id: s.id,
  roomId: s.roomId,
  label: s.label,
  monthlyRent: s.monthlyRent.toFixed(2),
  isActive: s.isActive,
  member: s.member ? { id: s.member.id, name: s.member.user.name, avatarUrl: s.member.user.avatarUrl } : null,
});

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

async function findRoom(db: DbClient, messId: string, roomId: string) {
  const room = await db.room.findFirst({
    where: { id: roomId, messId },
    include: { seats: { include: seatInclude } },
  });
  if (!room) throw ApiError.notFound("Room not found");
  return room;
}

async function findSeat(db: DbClient, messId: string, seatId: string) {
  const seat = await db.seat.findFirst({ where: { id: seatId, messId }, include: seatInclude });
  if (!seat) throw ApiError.notFound("Seat not found");
  return seat;
}

/** Every room with its seats and who's in them, plus occupancy and the rent roll. Everyone can see it. */
export async function listRooms(messId: string) {
  const rooms = await prisma.room.findMany({
    where: { messId },
    include: { seats: { include: seatInclude, orderBy: { label: "asc" } } },
    orderBy: { name: "asc" },
  });
  const seats = rooms.flatMap((r) => r.seats).filter((s) => s.isActive);
  const occupied = seats.filter((s) => s.member);
  return {
    rooms: rooms.map((r) => ({ id: r.id, name: r.name, floor: r.floor, seats: r.seats.map(toSeatDto) })),
    summary: {
      seats: seats.length,
      occupied: occupied.length,
      vacant: seats.length - occupied.length,
      /** Rent from occupied seats each month, before proration. */
      monthlyRent: sumMoney(occupied.map((s) => s.monthlyRent)).toFixed(2),
    },
  };
}

// ---------- rooms ----------

export async function createRoom(membership: Membership, input: RoomInput) {
  try {
    const room = await prisma.room.create({
      data: { messId: membership.messId, name: input.name, floor: input.floor ?? null },
    });
    await audit(prisma, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "ROOM_CREATED",
      entity: "Room",
      entityId: room.id,
      after: { name: room.name },
    });
    return { id: room.id, name: room.name, floor: room.floor, seats: [] };
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`There's already a room called “${input.name}”`);
    throw err;
  }
}

export async function updateRoom(membership: Membership, roomId: string, input: Partial<RoomInput>) {
  const room = await findRoom(prisma, membership.messId, roomId);
  try {
    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        ...(input.name && { name: input.name }),
        ...(input.floor !== undefined && { floor: input.floor }),
      },
      include: { seats: { include: seatInclude, orderBy: { label: "asc" } } },
    });
    return { id: updated.id, name: updated.name, floor: updated.floor, seats: updated.seats.map(toSeatDto) };
  } catch (err) {
    if (isUniqueViolation(err)) throw ApiError.conflict(`There's already a room called “${input.name}”`);
    throw err;
  }
}

/** A room can go once nobody lives in it; its seats go with it. */
export async function deleteRoom(membership: Membership, roomId: string) {
  const room = await findRoom(prisma, membership.messId, roomId);
  if (room.seats.some((s) => s.member)) {
    throw ApiError.conflict("Move everyone out of this room first");
  }
  await prisma.$transaction(async (tx) => {
    await tx.room.delete({ where: { id: room.id } });
    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: "ROOM_DELETED",
      entity: "Room",
      entityId: room.id,
      before: { name: room.name, seats: room.seats.length },
    });
  });
}

// ---------- seats ----------

export async function createSeat(membership: Membership, roomId: string, input: SeatInput) {
  const room = await findRoom(prisma, membership.messId, roomId);
  try {
    const seat = await prisma.seat.create({
      data: {
        messId: membership.messId,
        roomId: room.id,
        label: input.label,
        monthlyRent: new Prisma.Decimal(input.monthlyRent),
      },
      include: seatInclude,
    });
    return toSeatDto(seat);
  } catch (err) {
    if (isUniqueViolation(err))
      throw ApiError.conflict(`${room.name} already has a seat called “${input.label}”`);
    throw err;
  }
}

/** Rent changes apply from the month that is closed next (seat rent is charged at closing). */
export async function updateSeat(membership: Membership, seatId: string, input: UpdateSeatInput) {
  const seat = await findSeat(prisma, membership.messId, seatId);
  if (input.isActive === false && seat.member)
    throw ApiError.conflict("Move the member out of this seat first");
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.seat.update({
        where: { id: seat.id },
        data: {
          ...(input.label && { label: input.label }),
          ...(input.monthlyRent && { monthlyRent: new Prisma.Decimal(input.monthlyRent) }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
        include: seatInclude,
      });
      if (input.monthlyRent && !seat.monthlyRent.equals(input.monthlyRent)) {
        await audit(tx, {
          messId: membership.messId,
          actorId: membership.userId,
          action: "SEAT_RENT_CHANGED",
          entity: "Seat",
          entityId: seat.id,
          before: { monthlyRent: seat.monthlyRent.toFixed(2) },
          after: { monthlyRent: row.monthlyRent.toFixed(2) },
        });
      }
      return row;
    });
    return toSeatDto(updated);
  } catch (err) {
    if (isUniqueViolation(err))
      throw ApiError.conflict(`That room already has a seat called “${input.label}”`);
    throw err;
  }
}

export async function deleteSeat(membership: Membership, seatId: string) {
  const seat = await findSeat(prisma, membership.messId, seatId);
  if (seat.member) throw ApiError.conflict("Move the member out of this seat first");
  await prisma.seat.delete({ where: { id: seat.id } });
}

/**
 * Puts an active member in a seat (moving them out of any seat they had) or empties it. A seat holds
 * one member; a taken seat has to be emptied first, so nobody is moved out by accident.
 */
export async function assignSeat(membership: Membership, seatId: string, memberId: string | null) {
  const seat = await findSeat(prisma, membership.messId, seatId);
  if (memberId === (seat.member?.id ?? null)) return toSeatDto(seat);

  return prisma.$transaction(async (tx) => {
    if (memberId) {
      if (!seat.isActive) throw ApiError.conflict("This seat isn't in use");
      if (seat.member) throw ApiError.conflict(`${seat.member.user.name} is in this seat. Empty it first.`);
      const member = await tx.messMember.findFirst({
        where: { id: memberId, messId: membership.messId, status: MemberStatus.ACTIVE },
      });
      if (!member) throw ApiError.notFound("Member not found");
    }
    if (seat.member) await tx.messMember.update({ where: { id: seat.member.id }, data: { seatId: null } });
    if (memberId) await tx.messMember.update({ where: { id: memberId }, data: { seatId: seat.id } });

    await audit(tx, {
      messId: membership.messId,
      actorId: membership.userId,
      action: memberId ? "SEAT_ASSIGNED" : "SEAT_EMPTIED",
      entity: "Seat",
      entityId: seat.id,
      before: { memberId: seat.member?.id ?? null },
      after: { memberId },
    });
    return toSeatDto(await tx.seat.findUniqueOrThrow({ where: { id: seat.id }, include: seatInclude }));
  });
}

/**
 * When a member leaves, their seat rent for the current month is charged up to their last day (the
 * month's other members are charged at closing), and the seat is freed. Call after `leftAt` is set.
 */
export async function settleSeatOnLeave(tx: DbClient, memberId: string, actorUserId: string) {
  const member = await tx.messMember.findUniqueOrThrow({
    where: { id: memberId },
    include: {
      seat: true,
      mess: { select: { timezone: true, settings: { select: { prorateSeatRent: true } } } },
    },
  });
  if (!member.seat || !member.leftAt) return;

  const month = await tx.messMonth.findFirst({
    where: { messId: member.messId, startDate: { lte: member.leftAt }, endDate: { gte: member.leftAt } },
  });
  const alreadyCharged =
    month &&
    (await tx.memberCharge.count({ where: { monthId: month.id, memberId, type: ChargeType.SEAT_RENT } })) > 0;
  const rent =
    month && seatRent(member.seat.monthlyRent, member, month, member.mess.settings?.prorateSeatRent ?? true);

  if (month && month.status === MonthStatus.OPEN && rent && !alreadyCharged) {
    await tx.memberCharge.create({
      data: {
        messId: member.messId,
        monthId: month.id,
        memberId,
        type: ChargeType.SEAT_RENT,
        amount: rent.amount,
        description: `Seat ${member.seat.label} until ${rent.periodTo}`,
        periodFrom: toDbDate(rent.periodFrom),
        periodTo: toDbDate(rent.periodTo),
        isProrated: rent.isProrated,
        createdById: actorUserId,
      },
    });
  }
  await tx.messMember.update({ where: { id: memberId }, data: { seatId: null } });
}
