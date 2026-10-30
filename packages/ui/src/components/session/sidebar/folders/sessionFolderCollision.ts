import { closestCenter, pointerWithin, rectIntersection, type CollisionDetection } from '@dnd-kit/core';

/**
 * A session lands in the folder under the pointer, and nowhere when the
 * pointer is over no folder; a keyboard drag has no pointer and lands in the
 * folder its row was moved onto. Other drags (the project header sort) keep
 * the nearest target.
 */
export const sessionFolderCollision: CollisionDetection = (args) => {
  if (args.active.data.current?.type !== 'session') return closestCenter(args);
  const folderArgs = {
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => container.data.current?.type === 'folder'),
  };
  return args.pointerCoordinates ? pointerWithin(folderArgs) : rectIntersection(folderArgs);
};
