const RichContentList = ({ items }: { items: React.ReactNode[] }) => {
  return (
    <ul className="gap-sm pl-base flex list-disc flex-col">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
};

export default RichContentList;
