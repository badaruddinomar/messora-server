import { z } from "zod";
import { money } from "../../utils/schemas.js";

export const roomSchema = z.object({
  name: z.string().trim().min(1, "Name the room").max(40),
  floor: z.string().trim().max(20).nullish(),
});

export const updateRoomSchema = roomSchema.partial();

export const seatSchema = z.object({
  label: z.string().trim().min(1, "Name the seat").max(20),
  monthlyRent: money,
});

export const updateSeatSchema = seatSchema.extend({ isActive: z.boolean() }).partial();

export const assignSeatSchema = z.object({ memberId: z.uuid().nullable() });

export const roomParams = z.object({ messId: z.uuid(), roomId: z.uuid() });
export const seatParams = z.object({ messId: z.uuid(), seatId: z.uuid() });

export type RoomInput = z.infer<typeof roomSchema>;
export type SeatInput = z.infer<typeof seatSchema>;
export type UpdateSeatInput = z.infer<typeof updateSeatSchema>;
